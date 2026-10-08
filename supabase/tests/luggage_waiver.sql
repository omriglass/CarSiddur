-- REQ §13.111 (a): the large-trunk requirement can be waived by whoever places by hand.
--   * every manual path refuses with `needs_large_trunk` (detail = JSON request ids/names + car) without
--     `allow_small_trunk`, and with it places and stamps requests.luggage_waived_at/by
--       edit_ride (move a ride / new ride with served), place_on_own_car, create_proposal (shift, merge) ->
--       send_proposal -> apply_proposal, swap_day_cars (+ preview), request_ride_change, place_series_on_car
--   * merge_preview reports a luggage-only problem as ok=false, code 'luggage', waivable=true
--   * a waived request moves/merges/swaps later without the flag, and every automatic path treats it as
--     "no large luggage" - while a NON-waived one is still refused by them (try_auto_approve, apply_solver_result)
--   * editing so that has_luggage changes clears the waiver; one that does not change it keeps it
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
  select set_config('app.small_trunk', '', true);   -- a suite is one transaction; a request is one transaction each
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
  car40 uuid:='00000000-0000-0000-0000-000000000040';   -- no large trunk
  car41 uuid:='00000000-0000-0000-0000-000000000041';   -- van, large_trunk
  car42 uuid:='00000000-0000-0000-0000-000000000042';   -- no large trunk
  car43 uuid:='00000000-0000-0000-0000-000000000043';   -- m2's own temporary car, no large trunk
  w date:=public.current_week_start()+1295;
  dt timestamptz; pub uuid; res jsonb; d text; v jsonb; prop uuid;
  q1 uuid; q2 uuid; q3 uuid; qh uuid; rid uuid; rid2 uuid; ver int; n int; v_fp jsonb;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);

  -- ======== (1) edit_ride: move a ride carrying a large-luggage request onto a car with no trunk ========
  dt:=((w+1)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,has_luggage)
    values(dept,w,m2,sadran,dest,typ,dt,dt+interval '3 hours','round_trip','assigned',home,true) returning id into q1;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car41,dt,dt+interval '3 hours',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rid;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid,q1,'driver','both','keep');
  perform pg_temp.as_user(sadran);
  assert public.request_needs_large_trunk(q1), 'a large-luggage request needs a large trunk';
  select version into ver from public.rides where id=rid;
  d:=pg_temp.expect_err(format($q$select public.edit_ride(%L::jsonb,%s)$q$, jsonb_build_object('id',rid,'department_id',dept,'week_start',w,
      'car_id',car40,'starts_at',dt,'ends_at',dt+interval '3 hours','origin_id',home,'destination_id',home,'driver_id',m2,'is_pinned',true,
      'served',jsonb_build_array(jsonb_build_object('request_id',q1,'role','driver','leg','both','car_mode','keep')))::text, ver),'needs_large_trunk');
  assert (d::jsonb->'request_ids') ? q1::text and d::jsonb->>'car_id'=car40::text and d::jsonb->>'car_name' is not null,
    format('needs_large_trunk detail names the request and the car, got %s', d);
  assert (select car_id from public.rides where id=rid)=car41 and (select luggage_waived_at from public.requests where id=q1) is null,
    'a refused edit changes nothing';
  perform pg_temp.as_user(sadran);
  perform public.edit_ride(jsonb_build_object('id',rid,'department_id',dept,'week_start',w,
      'car_id',car40,'starts_at',dt,'ends_at',dt+interval '3 hours','origin_id',home,'destination_id',home,'driver_id',m2,'is_pinned',true,
      'allow_small_trunk',true,
      'served',jsonb_build_array(jsonb_build_object('request_id',q1,'role','driver','leg','both','car_mode','keep'))), ver);
  set constraints all immediate; set constraints all deferred;
  assert (select car_id from public.rides where id=rid)=car40, 'edit_ride with allow_small_trunk moves the ride';
  assert (select luggage_waived_at is not null and luggage_waived_by=sadran from public.requests where id=q1), 'the request is stamped waived by the Sadran';
  assert not public.request_needs_large_trunk(q1), 'a waived request no longer needs a large trunk';
  -- a waived request moves again without the flag
  perform pg_temp.as_user(sadran);
  select version into ver from public.rides where id=rid;
  perform public.edit_ride(jsonb_build_object('id',rid,'department_id',dept,'week_start',w,
      'car_id',car42,'starts_at',dt,'ends_at',dt+interval '3 hours','origin_id',home,'destination_id',home,'driver_id',m2,'is_pinned',true,
      'served',jsonb_build_array(jsonb_build_object('request_id',q1,'role','driver','leg','both','car_mode','keep'))), ver);
  set constraints all immediate; set constraints all deferred;
  assert (select car_id from public.rides where id=rid)=car42, 'a waived request moves to another small car without the flag';

  -- ======== (2) the waiver follows has_luggage: unchanged keeps it, changed clears it ========
  update public.requests set notes='edited' where id=q1;
  update public.requests set has_luggage=true where id=q1;
  assert (select luggage_waived_at is not null from public.requests where id=q1), 'an edit that does not change has_luggage keeps the waiver';
  update public.requests set has_luggage=false where id=q1;
  assert (select luggage_waived_at is null and luggage_waived_by is null from public.requests where id=q1), 'turning luggage off clears the waiver';
  update public.requests set has_luggage=true where id=q1;
  assert public.request_needs_large_trunk(q1), 'luggage on again restores the requirement';
  perform pg_temp.as_user(sadran);
  perform pg_temp.expect_err(format($q$select public.assert_ride_seats_fit(%L)$q$, rid), 'luggage_capacity_violation');   -- no manual mode: the automatic refusal
  delete from public.ride_requests where ride_id=rid; delete from public.rides where id=rid; delete from public.requests where id=q1;

  -- ======== (3) edit_ride: a NEW ride serving a luggage request on a small car ========
  dt:=((w+2)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,has_luggage)
    values(dept,w,m1,sadran,dest,typ,dt,dt+interval '3 hours','round_trip','waitlisted',home,true) returning id into q2;
  perform pg_temp.as_user(sadran);
  perform pg_temp.expect_err(format($q$select public.edit_ride(%L::jsonb,null)$q$, jsonb_build_object('department_id',dept,'week_start',w,
      'car_id',car40,'starts_at',dt,'ends_at',dt+interval '3 hours','origin_id',home,'destination_id',home,'driver_id',m1,'is_pinned',true,
      'served',jsonb_build_array(jsonb_build_object('request_id',q2,'role','driver','leg','both','car_mode','keep')))::text),'needs_large_trunk');
  perform pg_temp.as_user(sadran);
  rid2:=public.edit_ride(jsonb_build_object('department_id',dept,'week_start',w,
      'car_id',car40,'starts_at',dt,'ends_at',dt+interval '3 hours','origin_id',home,'destination_id',home,'driver_id',m1,'is_pinned',true,
      'allow_small_trunk',true,
      'served',jsonb_build_array(jsonb_build_object('request_id',q2,'role','driver','leg','both','car_mode','keep'))),null);
  set constraints all immediate; set constraints all deferred;
  assert (select luggage_waived_at is not null from public.requests where id=q2), 'a new ride with allow_small_trunk waives the served request';
  delete from public.ride_requests where ride_id=rid2; delete from public.rides where id=rid2; delete from public.requests where id=q2;

  -- ======== (4) merge: merge_preview is a waivable verdict; create/send/apply honour the flag ========
  dt:=((w+3)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id)
    values(dept,w,m2,sadran,dest,typ,dt,dt+interval '3 hours','round_trip','assigned',home) returning id into qh;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car40,dt,dt+interval '3 hours',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rid;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid,qh,'driver','both','keep');
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,has_luggage)
    values(dept,w,m1,sadran,dest,typ,dt,dt+interval '3 hours','round_trip','waitlisted',home,true) returning id into q3;
  perform pg_temp.as_user(sadran);
  v:=public.merge_preview(rid,q3,'both');
  assert not (v->>'ok')::boolean and v->>'code'='luggage' and (v->>'waivable')::boolean, format('luggage-only merge problem is waivable, got %s',v);
  assert v->>'error'='merge_luggage_needs_large_trunk', 'the preview error stays merge_luggage_needs_large_trunk';
  assert coalesce(current_setting('app.small_trunk',true),'') <> 'allow', 'merge_preview leaves the setting as it found it';
  perform pg_temp.expect_err(format($q$select public.create_proposal(%L,%L,'merge',%L::jsonb,'x')$q$, q3, rid,
    jsonb_build_object('ride_id',rid,'legs',jsonb_build_array(jsonb_build_object('ride_id',rid,'leg','both','car_mode','passenger')))::text),
    'needs_large_trunk');
  perform pg_temp.as_user(sadran);
  prop:=public.create_proposal(q3, rid, 'merge', jsonb_build_object('ride_id',rid,'allow_small_trunk',true,
    'legs',jsonb_build_array(jsonb_build_object('ride_id',rid,'leg','both','car_mode','passenger'))), 'x');
  assert (select (payload->>'allow_small_trunk')::boolean from public.proposals where id=prop), 'the draft keeps the flag in its payload';
  perform pg_temp.as_user(sadran);
  perform public.send_proposal(prop,'{}');
  perform public.record_answer_on_behalf(prop,m2,true);
  perform public.record_answer_on_behalf(prop,m1,true);
  if (select status from public.proposals where id=prop)='accepted' then perform public.apply_proposal(prop); end if;
  set constraints all immediate; set constraints all deferred;
  assert (select status from public.proposals where id=prop)='applied', 'the merge proposal was applied';
  assert (select luggage_waived_at is not null and luggage_waived_by=sadran from public.requests where id=q3), 'applying the merge stamped the waiver';
  assert (select count(*) from public.ride_requests where ride_id=rid and request_id=q3)>0, 'the guest rides on the small car';
  -- a waived request is no luggage problem any more (preview ok for the waived guest on another small ride)
  assert public.merge_preview(rid,q3,'both')->>'code' is distinct from 'luggage', 'a waived request never reports luggage again';
  -- ask_to_join drafts can never carry the flag
  delete from public.proposals where request_id=q3;
  update public.requests set luggage_waived_at=null, luggage_waived_by=null where id=q3;
  delete from public.ride_requests where ride_id=rid and request_id=q3;
  perform pg_temp.as_user(m1);
  perform pg_temp.expect_err(format($q$select public.create_proposal(%L,%L,'merge',%L::jsonb,'x','{}','ask_to_join')$q$, q3, rid,
    jsonb_build_object('ride_id',rid,'allow_small_trunk',true,
      'legs',jsonb_build_array(jsonb_build_object('ride_id',rid,'leg','both','car_mode','passenger')))::text),'merge_luggage_needs_large_trunk');
  raise notice 'luggage_waiver (1)-(4) passed';
end $$;

-- The remaining cases use their own week and fixtures.
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  sadran uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car40 uuid:='00000000-0000-0000-0000-000000000040';
  car41 uuid:='00000000-0000-0000-0000-000000000041';
  car42 uuid:='00000000-0000-0000-0000-000000000042';
  car43 uuid:='00000000-0000-0000-0000-000000000043';
  w date:=public.current_week_start()+1302;
  dt timestamptz; pub uuid; res jsonb; d text; prop uuid; q1 uuid; q2 uuid; rid uuid; rid2 uuid; ver int; preview jsonb; day date;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);

  -- ======== (5) shift proposal to a small car ========
  dt:=((w+1)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,has_luggage,trip_type)
    values(dept,w,m1,sadran,dest,typ,dt,dt+interval '3 hours','round_trip','waitlisted',home,true,'round_trip') returning id into q1;
  perform pg_temp.as_user(sadran);
  perform pg_temp.expect_err(format($q$select public.create_proposal(%L,null,'shift',%L::jsonb,'x')$q$, q1, jsonb_build_object('car_id',car40)::text),'needs_large_trunk');
  perform pg_temp.as_user(sadran);
  prop:=public.create_proposal(q1,null,'shift',jsonb_build_object('car_id',car40,'allow_small_trunk',true),'x');
  assert prop is not null, 'a shift draft with allow_small_trunk is created';
  perform pg_temp.as_user(m1);
  prop:=public.create_proposal(q1,null,'shift',jsonb_build_object('car_id',car41,'allow_small_trunk',true),'x','{}','ask_to_join');
  assert not (select payload ? 'allow_small_trunk' from public.proposals p where p.id=prop), 'a non-Sadran proposal never keeps the flag';
  delete from public.proposals where request_id=q1;

  -- ======== (6) place_on_own_car: the owner's own car, no large trunk ========
  dt:=((w+2)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,trip_type,status_reason,has_luggage)
    values(dept,w,m2,m2,dest,typ,dt,dt+interval '3 hours','round_trip','waitlisted',home,'round_trip','WAITLISTED_NO_CAR',true) returning id into q2;
  perform pg_temp.as_user(m2);
  d:=pg_temp.expect_err(format($q$select public.place_on_own_car(%L,%L)$q$, q2, car43),'needs_large_trunk');
  assert d::jsonb->>'car_name' is not null, 'own-car refusal names the car';
  perform pg_temp.as_user(m2);
  res:=public.place_on_own_car(q2, car43, true);
  assert res->>'status'='assigned', format('place_on_own_car with allow_small_trunk assigns, got %s',res);
  assert (select luggage_waived_at is not null and luggage_waived_by=m2 from public.requests where id=q2), 'the owner waived their own request';
  delete from public.ride_requests where request_id=q2; delete from public.rides where car_id=car43 and week_start=w; delete from public.requests where id=q2;
  delete from public.requests where id=q1;

  -- ======== (7) swap_day_cars: preview says waivable, the swap needs the flag ========
  day:=w+3;
  dt:=(day+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,has_luggage)
    values(dept,w,m1,sadran,dest,typ,dt,dt+interval '3 hours','round_trip','assigned',home,true) returning id into q1;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car41,dt,dt+interval '3 hours',home,home,m1,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rid;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid,q1,'driver','both','keep');
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id)
    values(dept,w,m2,sadran,dest,typ,dt,dt+interval '3 hours','round_trip','assigned',home) returning id into q2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car42,dt,dt+interval '3 hours',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rid2;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid2,q2,'driver','both','keep');
  set constraints all immediate; set constraints all deferred;
  perform pg_temp.as_user(sadran);
  preview:=public.preview_day_car_swap(dept,w,day,car41,car42);
  assert (preview->>'can_swap')::boolean and (preview->>'needs_small_trunk')::boolean, format('preview: swap possible but needs the small-trunk flag, got %s',preview);
  assert exists(select 1 from jsonb_array_elements(preview->'blockers') b where b->>'code'='luggage' and (b->>'waivable')::boolean and (b->'request_ids') ? q1::text),
    'preview: a waivable luggage blocker naming the request';
  d:=pg_temp.expect_err(format($q$select public.swap_day_cars(%L,%L,%L,%L,%L,%L)$q$, dept,w,day,car41,car42,preview->>'fingerprint'),'needs_large_trunk');
  assert (select car_id from public.rides where id=rid)=car41, 'a refused swap moves nothing';
  perform pg_temp.as_user(sadran);
  res:=public.swap_day_cars(dept,w,day,car41,car42,preview->>'fingerprint','whole',true);
  set constraints all immediate; set constraints all deferred;
  assert (select car_id from public.rides where id=rid)=car42 and (select car_id from public.rides where id=rid2)=car41, 'the swap went through with allow_small_trunk';
  assert (select luggage_waived_at is not null from public.requests where id=q1), 'the swapped request is waived';
  -- swap back: the waived request is no blocker any more
  perform pg_temp.as_user(sadran);
  preview:=public.preview_day_car_swap(dept,w,day,car41,car42);
  assert (preview->>'can_swap')::boolean and not (preview->>'needs_small_trunk')::boolean, format('a waived request blocks no swap, got %s',preview);
  res:=public.swap_day_cars(dept,w,day,car41,car42,preview->>'fingerprint');
  set constraints all immediate; set constraints all deferred;
  assert (select car_id from public.rides where id=rid)=car41, 'swapped back without the flag';
  delete from public.ride_requests where ride_id in (rid,rid2); delete from public.rides where id in (rid,rid2); delete from public.requests where id in (q1,q2);

  -- ======== (8) request_ride_change: the driver may accept a small car for their own luggage request ========
  dt:=((w+4)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,has_luggage)
    values(dept,w,m2,m2,dest,typ,dt,dt+interval '3 hours','round_trip','assigned',home,true) returning id into q1;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car41,dt,dt+interval '3 hours',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rid;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid,q1,'driver','both','keep');
  select version into ver from public.rides where id=rid;
  perform pg_temp.as_user(m2);
  perform pg_temp.expect_err(format($q$select public.request_ride_change(%L,%L,%L,%L,%s)$q$, rid, car42, dt+interval '1 hour', dt+interval '4 hours', ver),'needs_large_trunk');
  -- with the flag the call passes the large-trunk gate (and stops at the next rule: no conflicting ride to ask)
  perform pg_temp.as_user(m2);
  perform pg_temp.expect_err(format($q$select public.request_ride_change(%L,%L,%L,%L,%s,true)$q$, rid, car42, dt+interval '1 hour', dt+interval '4 hours', ver),'no_conflicting_ride');
  delete from public.ride_requests where ride_id=rid; delete from public.rides where id=rid; delete from public.requests where id=q1;

  -- ======== (9) automatic paths stay strict ========
  dt:=((w+5)+time '09:00') at time zone 'Asia/Jerusalem';
  -- only the van has a trunk and it is busy: a non-waived luggage request is waitlisted by the auto-approve
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car41,dt-interval '1 hour',dt+interval '6 hours',home,home,sadran,'confirmed',true,'SADRAN_MANUAL',sadran);
  perform pg_temp.as_user(m1);
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'depart_at',dt,'return_at',dt+interval '3 hours','trip_type','round_trip','adults',1,'has_luggage',true));
  assert res->>'status'='waitlisted', format('auto-approve still refuses a non-waived luggage request on small cars, got %s',res);
  q1:=(res->>'request_id')::uuid;
  -- apply_solver_result with the small car: the central check refuses (luggage_capacity_violation), as before
  perform pg_temp.as_user(sadran);
  perform pg_temp.expect_err(format($q$select public.apply_solver_result(%L,%L,%L::jsonb)$q$, dept, w, jsonb_build_object('mode','remaining',
    'rides',jsonb_build_array(jsonb_build_object('car_id',car40,'starts_at',dt,'ends_at',dt+interval '3 hours','origin_id',home,'destination_id',home,
      'driver_id',m1,'is_pinned',false,'pin_reason',null,
      'served',jsonb_build_array(jsonb_build_object('request_id',q1,'role','driver','leg','both','car_mode','keep')))),
    'request_statuses','[]'::jsonb,'policy_version_id','00000000-0000-0000-0000-000000000031','input_hash','lw','solver_version','test',
    'started_at',now()::text,'finished_at',now()::text,'duration_ms',0,'summary','{}'::jsonb)::text),'luggage_capacity_violation');
  -- once waived (by hand), the same request is no luggage problem for the automatic path
  perform pg_temp.as_user(m1);
  update public.requests set luggage_waived_at=now(), luggage_waived_by=sadran where id=q1;
  res:=public.try_auto_approve(q1);
  assert res->>'status'='assigned', format('a waived request is auto-placed on a plain car, got %s',res);
  raise notice 'luggage_waiver: all assertions passed';
end $$;

-- ======== (10) place_series_on_car: every leg of a multi-day series is waived together ========
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  sadran uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car40 uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+1309;
  res jsonb; sid uuid; d text;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');
  perform pg_temp.as_user(m1);
  res := public.submit_series_request(jsonb_build_object('department_id', dept, 'week_start', w, 'destination_id', dest, 'ride_type_id', typ,
    'trip_shape', 'round_trip', 'adults', 1, 'has_luggage', true,
    'depart_at', ((w + 1) + time '09:00') at time zone 'Asia/Jerusalem', 'return_at', ((w + 3) + time '17:00') at time zone 'Asia/Jerusalem'));
  sid := (res ->> 'series_id')::uuid;
  perform pg_temp.as_user(sadran);
  d := pg_temp.expect_err(format($q$select public.place_series_on_car(%L,%L)$q$, sid, car40), 'needs_large_trunk');
  assert jsonb_array_length(d::jsonb -> 'request_ids') = 3, format('the refusal names all three legs, got %s', d);
  perform pg_temp.as_user(sadran);
  perform public.place_series_on_car(sid, car40, true);
  set constraints all immediate; set constraints all deferred;
  assert (select count(*) from public.requests where series_id = sid and luggage_waived_at is not null) = 3, 'all legs are waived';
  assert (select count(distinct car_id) from public.rides where series_id = sid and status <> 'cancelled') = 1, 'one car for the series';
  raise notice 'luggage_waiver (10) series passed';
end $$;

-- ======== (11) member paths: submit_request quick / car-now (ask_small_trunk) and ask-to-join ========
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  sadran uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car40 uuid:='00000000-0000-0000-0000-000000000040';
  car41 uuid:='00000000-0000-0000-0000-000000000041';
  w date:=public.current_week_start()+1316;
  dt timestamptz; pub uuid; res jsonb; d text; n int; rid uuid; vanride uuid; base jsonb;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);

  -- van busy: only small cars are free
  dt:=((w+1)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car41,dt-interval '1 hour',dt+interval '6 hours',home,home,sadran,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into vanride;
  base:=jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'depart_at',dt,'return_at',dt+interval '3 hours','trip_type','round_trip','adults',1,'has_luggage',true);
  -- the plain submit stays strict (waitlisted), even when asked for a chosen small car
  perform pg_temp.as_user(m1);
  res:=public.submit_request(base||jsonb_build_object('preferred_car_id',car40));
  assert res->>'status'='waitlisted', format('plain submit stays strict, got %s',res);
  perform public.withdraw_request((res->>'request_id')::uuid, (select version from public.requests where id=(res->>'request_id')::uuid));
  -- quick / car-now: asks (no request is created by the refused call)
  select count(*) into n from public.requests where requester_id=m1 and depart_at=dt;
  d:=pg_temp.expect_err(format($q$select public.submit_request(%L::jsonb)$q$, (base||jsonb_build_object('ask_small_trunk',true))::text),'needs_large_trunk');
  assert d::jsonb->>'car_name' is not null and jsonb_array_length(d::jsonb->'request_ids')=1, format('detail names a small car, got %s',d);
  assert (select count(*) from public.requests where requester_id=m1 and depart_at=dt)=n, 'the refused submit created nothing';
  -- confirmed: placed on a small car and waived
  perform pg_temp.as_user(m1);
  res:=public.submit_request(base||jsonb_build_object('ask_small_trunk',true,'allow_small_trunk',true));
  assert res->>'status'='assigned', format('allow_small_trunk places on a small car, got %s',res);
  assert (select luggage_waived_at is not null and luggage_waived_by=m1 from public.requests where id=(res->>'request_id')::uuid), 'the member waived their own requirement';
  assert not exists(select 1 from public.cars c where c.id=(res->>'car_id')::uuid and 'large_trunk'=any(c.features)), 'placed on a car without a large trunk';
  -- van free: car-now prefers it, nothing to ask and nothing waived
  delete from public.rides where id=vanride;
  dt:=((w+2)+time '09:00') at time zone 'Asia/Jerusalem';
  perform pg_temp.as_user(m2);
  res:=public.submit_request((base||jsonb_build_object('depart_at',dt,'return_at',dt+interval '3 hours','ask_small_trunk',true,'allow_small_trunk',true,'preferred_car_id',car40)));
  assert (res->>'car_id')::uuid=car41, format('a free large-trunk car is preferred over the chosen small one, got %s',res);
  assert (select luggage_waived_at is null from public.requests where id=(res->>'request_id')::uuid), 'no waiver when a large-trunk car took it';

  -- ask-to-join a ride on a small car
  dt:=((w+3)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car40,dt,dt+interval '3 hours',home,home,sadran,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rid;
  perform pg_temp.as_user(m1);
  d:=pg_temp.expect_err(format($q$select public.submit_request(%L::jsonb)$q$, (base||jsonb_build_object('depart_at',dt,'return_at',dt+interval '3 hours','join_ride_id',rid))::text),'needs_large_trunk');
  perform pg_temp.as_user(m1);
  res:=public.submit_request(base||jsonb_build_object('depart_at',dt,'return_at',dt+interval '3 hours','join_ride_id',rid,'allow_small_trunk',true));
  assert (select luggage_waived_at is not null from public.requests where id=(res->>'request_id')::uuid), 'ask-to-join with allow_small_trunk waives the member''s requirement';
  raise notice 'luggage_waiver (11) member paths passed';
end $$;
rollback;
