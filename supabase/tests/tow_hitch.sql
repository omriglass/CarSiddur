-- REQ §13.200: a request can need a towing car (רכב גורר, car feature tow_hitch), the second car need beside large
-- luggage; same rule, same waiver (luggage_waived_at now means "car needs waived"):
--   * automatic placement (submit_request -> try_auto_approve, freed/waiting paths via car_meets_needs) refuses a car without the hitch
--   * a manual drop (edit_ride) refuses with `needs_large_trunk` and detail.needs = ['tow_hitch']; allow_small_trunk places and waives
--   * one hitch = one towing request per ride (detail.tow_taken_by names the one holding it)
--   * a request needing both and a car with neither: one refusal naming both needs
--   * merge_preview / swap preview report a waivable verdict
--   * editing needs_tow_hitch clears the waiver; an edit that leaves it keeps it
--   * submit_request warns NO_CAR_FITS_TOW_HITCH when no active car has a hitch
-- Transactional (begin ... rollback), like the other suites.
begin;
create or replace function pg_temp.expect_err(p_sql text, p_expect text) returns text language plpgsql as $f$
declare v_detail text;
begin
  execute p_sql;
  execute 'set constraints all immediate';
  raise exception 'EXPECTED_FAILURE_MISSING: % (wanted %)', p_sql, p_expect;
exception when others then
  if sqlerrm like 'EXPECTED_FAILURE_MISSING%' then raise; end if;
  get stacked diagnostics v_detail = pg_exception_detail;
  if sqlerrm = p_expect or sqlstate = p_expect then return v_detail; end if;
  raise exception 'wanted %, got % (%): %', p_expect, sqlerrm, sqlstate, p_sql;
end $f$;
create or replace function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p, 'role', 'authenticated')::text, true);
  select set_config('app.small_trunk', '', true);
$f$;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  sadran uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car40 uuid:='00000000-0000-0000-0000-000000000040';   -- no features
  car41 uuid:='00000000-0000-0000-0000-000000000041';   -- van, large_trunk
  car42 uuid:='00000000-0000-0000-0000-000000000042';   -- gets tow_hitch below
  w date:=public.current_week_start()+1400;
  dt timestamptz; pub uuid; res jsonb; d text; v jsonb; preview jsonb; day date;
  q1 uuid; q2 uuid; q3 uuid; qh uuid; rid uuid; rid2 uuid; ver int;
begin
  update public.cars set features = array['tow_hitch'] where id = car42;
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);

  -- ======== (1) automatic placement: only the hitch car; a busy hitch car leaves the request waitlisted ========
  dt:=((w+1)+time '09:00') at time zone 'Asia/Jerusalem';
  perform pg_temp.as_user(m1);
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'depart_at',dt,'return_at',dt+interval '3 hours','trip_type','round_trip','adults',1,'needs_tow_hitch',true));
  assert res->>'status'='assigned' and (res->>'car_id')::uuid=car42, format('a towing request is auto-placed on the hitch car, got %s',res);
  q1:=(res->>'request_id')::uuid;
  assert (select needs_tow_hitch from public.requests where id=q1), 'needs_tow_hitch is stored';
  -- the hitch car is now busy: a second towing request is waitlisted (car40/car41 have no hitch)
  perform pg_temp.as_user(m2);
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'depart_at',dt,'return_at',dt+interval '3 hours','trip_type','round_trip','adults',1,'needs_tow_hitch',true));
  assert res->>'status'='waitlisted', format('auto-approve refuses a car without the hitch, got %s',res);
  q2:=(res->>'request_id')::uuid;
  assert (select count(*) from public.rides where week_start=w and car_id=car42 and status<>'cancelled')=1, 'only one ride on the hitch car';

  -- ======== (2) manual drop of q2 on the hitch car's ride (already towing for q1): the hitch is taken ========
  select r.id, r.version into rid, ver from public.rides r where r.week_start=w and r.car_id=car42 and r.status<>'cancelled';
  update public.ride_requests set created_at = now() - interval '1 hour' where ride_id = rid;   -- q1 was there first (the suite is one transaction)
  perform pg_temp.as_user(sadran);
  perform set_config('app.small_trunk','ask',true);
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid,q2,'passenger','both','passenger');
  d:=pg_temp.expect_err(format($q$select public.assert_ride_seats_fit(%L)$q$, rid),'needs_large_trunk');
  assert d::jsonb->'needs' ? 'tow_hitch' and d::jsonb->>'tow_taken_by' is not null and (d::jsonb->'request_ids') ? q2::text,
    format('hitch taken: needs tow_hitch, names the holder, asks about the second request, got %s', d);
  assert not ((d::jsonb->'request_ids') ? q1::text), 'the request holding the hitch is not asked about';
  delete from public.ride_requests where ride_id=rid and request_id=q2;
  -- automatic mode (no manual funnel): the strict refusal
  perform set_config('app.small_trunk','',true);
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid,q2,'passenger','both','passenger');
  perform pg_temp.expect_err(format($q$select public.assert_ride_seats_fit(%L)$q$, rid),'luggage_capacity_violation');
  delete from public.ride_requests where ride_id=rid and request_id=q2;
  delete from public.ride_requests where ride_id=rid; delete from public.rides where id=rid;

  -- ======== (3) manual drop on a car with no hitch: refused, then allowed + waived ========
  perform pg_temp.as_user(sadran);
  d:=pg_temp.expect_err(format($q$select public.edit_ride(%L::jsonb,null)$q$, jsonb_build_object('department_id',dept,'week_start',w,
      'car_id',car40,'starts_at',dt,'ends_at',dt+interval '3 hours','origin_id',home,'destination_id',home,'driver_id',m2,'is_pinned',true,
      'served',jsonb_build_array(jsonb_build_object('request_id',q2,'role','driver','leg','both','car_mode','keep')))::text),'needs_large_trunk');
  assert d::jsonb->'needs' = '["tow_hitch"]'::jsonb and d::jsonb->>'tow_taken_by' is null and d::jsonb->>'car_name' is not null,
    format('no hitch: needs exactly tow_hitch, got %s', d);
  assert (select luggage_waived_at from public.requests where id=q2) is null, 'a refused drop waives nothing';
  perform pg_temp.as_user(sadran);
  rid2:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,
      'car_id',car40,'starts_at',dt,'ends_at',dt+interval '3 hours','origin_id',home,'destination_id',home,'driver_id',m2,'is_pinned',true,
      'allow_small_trunk',true,
      'served',jsonb_build_array(jsonb_build_object('request_id',q2,'role','driver','leg','both','car_mode','keep'))),null);
  set constraints all immediate; set constraints all deferred;
  assert (select luggage_waived_at is not null and luggage_waived_by=sadran from public.requests where id=q2), 'allow_small_trunk placed it and stamped the waiver';
  assert not public.request_needs_tow_hitch(q2), 'a waived request no longer needs a hitch';

  -- ======== (4) the waiver follows needs_tow_hitch: unchanged keeps it, changed clears it ========
  update public.requests set notes='edited' where id=q2;
  update public.requests set needs_tow_hitch=true where id=q2;
  assert (select luggage_waived_at is not null from public.requests where id=q2), 'an edit leaving needs_tow_hitch as it was keeps the waiver';
  update public.requests set needs_tow_hitch=false where id=q2;
  assert (select luggage_waived_at is null and luggage_waived_by is null from public.requests where id=q2), 'turning towing off clears the waiver';
  update public.requests set needs_tow_hitch=true where id=q2;
  assert public.request_needs_tow_hitch(q2), 'towing on again restores the requirement';
  delete from public.ride_requests where ride_id=rid2; delete from public.rides where id=rid2;

  -- ======== (5) both needs, a car with neither: one refusal naming both ========
  update public.requests set has_luggage=true where id=q2;
  perform pg_temp.as_user(sadran);
  d:=pg_temp.expect_err(format($q$select public.edit_ride(%L::jsonb,null)$q$, jsonb_build_object('department_id',dept,'week_start',w,
      'car_id',car40,'starts_at',dt,'ends_at',dt+interval '3 hours','origin_id',home,'destination_id',home,'driver_id',m2,'is_pinned',true,
      'served',jsonb_build_array(jsonb_build_object('request_id',q2,'role','driver','leg','both','car_mode','keep')))::text),'needs_large_trunk');
  assert d::jsonb->'needs' ? 'tow_hitch' and d::jsonb->'needs' ? 'large_trunk', format('both needs named, got %s', d);
  -- the van has a large trunk but no hitch: only the hitch is missing
  perform pg_temp.as_user(sadran);
  d:=pg_temp.expect_err(format($q$select public.edit_ride(%L::jsonb,null)$q$, jsonb_build_object('department_id',dept,'week_start',w,
      'car_id',car41,'starts_at',dt,'ends_at',dt+interval '3 hours','origin_id',home,'destination_id',home,'driver_id',m2,'is_pinned',true,
      'served',jsonb_build_array(jsonb_build_object('request_id',q2,'role','driver','leg','both','car_mode','keep')))::text),'needs_large_trunk');
  assert d::jsonb->'needs' = '["tow_hitch"]'::jsonb, format('van lacks only the hitch, got %s', d);
  update public.requests set has_luggage=false where id=q2;

  -- ======== (6) merge_preview: a towing guest on a ride whose car has no hitch is a waivable verdict ========
  day:=w+2;
  dt:=(day+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id)
    values(dept,w,m2,sadran,dest,typ,dt,dt+interval '3 hours','round_trip','assigned',home) returning id into qh;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car40,dt,dt+interval '3 hours',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rid;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid,qh,'driver','both','keep');
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,needs_tow_hitch)
    values(dept,w,m1,sadran,dest,typ,dt,dt+interval '3 hours','round_trip','waitlisted',home,true) returning id into q3;
  perform pg_temp.as_user(sadran);
  v:=public.merge_preview(rid,q3,'both');
  assert not (v->>'ok')::boolean and v->>'code'='luggage' and (v->>'waivable')::boolean and v->'needs' ? 'tow_hitch',
    format('towing merge problem is waivable and names tow_hitch, got %s',v);
  delete from public.ride_requests where ride_id=rid; delete from public.rides where id=rid; delete from public.requests where id in (qh,q3);

  -- ======== (7) swap preview: moving a towing ride onto a car without the hitch is a waivable blocker ========
  day:=w+3;
  dt:=(day+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,needs_tow_hitch)
    values(dept,w,m1,sadran,dest,typ,dt,dt+interval '3 hours','round_trip','assigned',home,true) returning id into q1;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car42,dt,dt+interval '3 hours',home,home,m1,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rid;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid,q1,'driver','both','keep');
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id)
    values(dept,w,m2,sadran,dest,typ,dt,dt+interval '3 hours','round_trip','assigned',home) returning id into q2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car40,dt,dt+interval '3 hours',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rid2;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid2,q2,'driver','both','keep');
  set constraints all immediate; set constraints all deferred;
  perform pg_temp.as_user(sadran);
  preview:=public.preview_day_car_swap(dept,w,day,car42,car40);
  assert (preview->>'can_swap')::boolean and (preview->>'needs_small_trunk')::boolean, format('swap possible only with the flag, got %s',preview);
  assert exists(select 1 from jsonb_array_elements(preview->'blockers') b where b->>'code'='luggage' and (b->>'waivable')::boolean and (b->'request_ids') ? q1::text),
    'a waivable blocker naming the towing request';
  d:=pg_temp.expect_err(format($q$select public.swap_day_cars(%L,%L,%L,%L,%L,%L)$q$, dept,w,day,car42,car40,preview->>'fingerprint'),'needs_large_trunk');
  assert d::jsonb->'needs' ? 'tow_hitch', format('swap refusal names the hitch, got %s', d);
  assert (select car_id from public.rides where id=rid)=car42, 'a refused swap moves nothing';
  perform pg_temp.as_user(sadran);
  perform public.swap_day_cars(dept,w,day,car42,car40,preview->>'fingerprint','whole',true);
  set constraints all immediate; set constraints all deferred;
  assert (select car_id from public.rides where id=rid)=car40 and (select luggage_waived_at is not null from public.requests where id=q1), 'swapped with the flag and waived';
  delete from public.ride_requests where ride_id in (rid,rid2); delete from public.rides where id in (rid,rid2); delete from public.requests where id in (q1,q2);

  -- ======== (8) submit_request warns when no active car has a hitch ========
  update public.cars set features = '{}' where id = car42;
  perform pg_temp.as_user(m1);
  dt:=((w+5)+time '09:00') at time zone 'Asia/Jerusalem';
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'depart_at',dt,'return_at',dt+interval '3 hours','trip_type','round_trip','adults',1,'needs_tow_hitch',true));
  assert res::text like '%NO_CAR_FITS_TOW_HITCH%', format('the no-hitch-car warning is returned, got %s',res);
  raise notice 'tow_hitch: all assertions passed';
end $$;
rollback;
