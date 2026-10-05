-- REQ §13.101 (a)(c)(e)(f)(g)(h)(i) + QB14: placement / request features.
--   luggage needs a large_trunk car (auto-approve, ride seat check)   set_ride_driver
--   withdraw/restore duplicate request                                place_on_own_car
--   edit on a published day (move, confirm-release, drives others)    overlaps in submit_request
--   QB14 real destination in add_ride_passengers notices              QF7 freed car goes to the contested group first
-- Transactional (begin ... rollback), like the other suites.
begin;
create or replace function pg_temp.expect_err(p_sql text, p_expect text) returns void language plpgsql as $f$
begin
  execute p_sql;
  execute 'set constraints all immediate';
  raise exception 'EXPECTED_FAILURE_MISSING: % (wanted %)', p_sql, p_expect;
exception when others then
  if sqlerrm like 'EXPECTED_FAILURE_MISSING%' then raise; end if;
  if sqlerrm = p_expect or sqlstate = p_expect then return; end if;
  raise exception 'wanted %, got % (%): %', p_expect, sqlerrm, sqlstate, p_sql;
end $f$;
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
  w date:=public.current_week_start()+1190;
  dt timestamptz; pub uuid; res jsonb; r jsonb; q1 uuid; q2 uuid; q3 uuid; rid uuid; rid2 uuid; n int; g uuid; off uuid; v text;
  dest_name text; procedure_ok boolean;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  select name into dest_name from public.destinations where id=dest;

  -- ---- (a) luggage: only a large_trunk car, even when plain cars are free -----------------------------
  dt:=((w+1)+time '09:00') at time zone 'Asia/Jerusalem';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car41,dt-interval '1 hour',dt+interval '6 hours',home,home,sadran,'confirmed',true,'SADRAN_MANUAL',sadran);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'depart_at',dt,'return_at',dt+interval '3 hours','trip_type','round_trip','adults',1,'has_luggage',true));
  assert res->>'status'='waitlisted', format('luggage: the plain cars are free but only the van has a trunk; got %s',res);
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'depart_at',dt+interval '4 hours','return_at',dt+interval '5 hours','trip_type','round_trip','adults',1,'has_luggage',false));
  assert res->>'status'='assigned', format('luggage: a request without luggage takes a plain car; got %s',res);
  -- the central seat check refuses a luggage request linked to a car with no large trunk
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,has_luggage)
    values(dept,w,m2,sadran,dest,typ,dt+interval '1 day',dt+interval '1 day 3 hours','round_trip','waitlisted',home,true) returning id into q1;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car40,dt+interval '1 day',dt+interval '1 day 3 hours',home,home,m2,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rid;
  perform pg_temp.expect_err(format('insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(%L,%L,''driver'',''both'',''keep'')',rid,q1),'luggage_capacity_violation');
  delete from public.requests where id=q1;
  delete from public.rides where id=rid;

  -- ---- (c) set_ride_driver ---------------------------------------------------------------------------
  dt:=((w+2)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,trip_type)
    values(dept,w,m2,sadran,dest,typ,dt,dt+interval '3 hours','round_trip','waitlisted',home,'drop_off') returning id into q1;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,needs_driver,status,flag_reason,is_pinned,pin_reason,created_by)
    values(dept,w,car40,dt,dt+interval '3 hours',home,home,null,true,'flagged','NEEDS_DRIVER',true,'MISSING_DRIVER',sadran) returning id into rid;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid,q1,'passenger','both','chauffeur');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  procedure_ok:=false;
  begin perform public.set_ride_driver(rid,m1,(select version from public.rides where id=rid));
  exception when others then procedure_ok:=sqlerrm='not_authorized'; end;
  assert procedure_ok, 'set_ride_driver: a plain member is refused';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  procedure_ok:=false;
  begin perform public.set_ride_driver(rid,m1,(select version from public.rides where id=rid)+5);
  exception when others then procedure_ok:=sqlstate='P0409'; end;
  assert procedure_ok, 'set_ride_driver: stale version raises P0409';
  res:=public.set_ride_driver(rid,m1,(select version from public.rides where id=rid));
  assert (select driver_id=m1 and not needs_driver and status='confirmed' from public.rides where id=rid), 'set_ride_driver: driver set, ride no longer flagged';
  assert exists(select 1 from public.notifications where recipient_id=m1 and data->>'variant'='driver_assigned'), 'set_ride_driver: driver notified';
  assert exists(select 1 from public.notifications where recipient_id=m2 and data->>'variant'='driver_assigned_passenger'), 'set_ride_driver: passenger notified';
  -- a driver who is busy in that time is refused
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,needs_driver,status,flag_reason,is_pinned,pin_reason,created_by)
    values(dept,w,car42,dt+interval '30 minutes',dt+interval '2 hours',home,home,null,true,'flagged','NEEDS_DRIVER',true,'MISSING_DRIVER',sadran) returning id into rid2;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,trip_type)
    values(dept,w,sadran,sadran,dest,typ,dt+interval '30 minutes',dt+interval '2 hours','round_trip','waitlisted',home,'drop_off') returning id into q2;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid2,q2,'passenger','both','chauffeur');
  procedure_ok:=false;
  begin perform public.set_ride_driver(rid2,m1,(select version from public.rides where id=rid2));
  exception when others then procedure_ok:=sqlerrm='driver_already_busy'; end;
  assert procedure_ok, 'set_ride_driver: overlapping own ride refused (driver_already_busy)';
  -- back to needs-driver
  res:=public.set_ride_driver(rid,null,(select version from public.rides where id=rid));
  assert (select needs_driver and driver_id is null from public.rides where id=rid), 'set_ride_driver(null): back to needs-driver';
  assert exists(select 1 from public.notifications where recipient_id=m2 and data->>'variant'='driver_unassigned'), 'set_ride_driver(null): passenger notified';
  delete from public.ride_requests where ride_id in (rid,rid2);
  delete from public.rides where id in (rid,rid2);
  delete from public.requests where id in (q1,q2);

  -- ---- (e) duplicate withdraw / restore ------------------------------------------------------------------
  dt:=((w+3)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,trip_type,status_reason)
    values(dept,w,m1,m1,dest,typ,dt,dt+interval '3 hours','round_trip','waitlisted',home,'round_trip','WAITLISTED_NO_CAR') returning id into q1;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  procedure_ok:=false;
  begin perform public.withdraw_duplicate_request(q1,(select version from public.requests where id=q1));
  exception when others then procedure_ok:=sqlerrm='not_authorized'; end;
  assert procedure_ok, 'withdraw_duplicate_request: only the Sadran';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  res:=public.withdraw_duplicate_request(q1,(select version from public.requests where id=q1));
  assert (select status::text='withdrawn' and status_reason='DUPLICATE_WITHDRAWN' from public.requests where id=q1), 'withdraw_duplicate_request: status/reason';
  assert exists(select 1 from public.notifications where recipient_id=m1 and data->>'variant'='duplicate_withdrawn' and data->>'url'='/my'), 'withdraw_duplicate_request: member notified, link /my';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  procedure_ok:=false;
  begin perform public.restore_duplicate_request(q1);
  exception when others then procedure_ok:=sqlerrm='not_authorized'; end;
  assert procedure_ok, 'restore_duplicate_request: only the requester';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  res:=public.restore_duplicate_request(q1);
  assert res->>'status' in ('assigned','waitlisted'), format('restore_duplicate_request: back to placement, got %s',res);
  assert exists(select 1 from public.notifications where recipient_id=sadran and data->>'variant'='duplicate_restored'), 'restore_duplicate_request: Sadran notified';
  procedure_ok:=false;
  begin perform public.restore_duplicate_request(q1);
  exception when others then procedure_ok:=sqlerrm='request_not_editable'; end;
  assert procedure_ok, 'restore_duplicate_request: only from DUPLICATE_WITHDRAWN';
  -- a withdrawn duplicate that held a ride releases it
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  select id into rid from public.rides where id in (select ride_id from public.ride_requests where request_id=q1) and status<>'cancelled';
  if rid is not null then
    perform public.withdraw_duplicate_request(q1,(select version from public.requests where id=q1));
    assert (select status::text from public.rides where id=rid)='cancelled', 'withdraw_duplicate_request: releases the booking';
  end if;
  delete from public.ride_requests where request_id=q1;
  delete from public.requests where id=q1;

  -- ---- (h) place_on_own_car ---------------------------------------------------------------------------------
  dt:=((w+4)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,trip_type,status_reason)
    values(dept,w,m2,m2,dest,typ,dt,dt+interval '3 hours','round_trip','waitlisted',home,'round_trip','WAITLISTED_NO_CAR') returning id into q1;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  perform pg_temp.expect_err(format('select public.place_on_own_car(%L,%L)',q1,car43),'not_authorized');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  perform pg_temp.expect_err(format('select public.place_on_own_car(%L,%L)',q1,car40),'private_car_owner_only');
  res:=public.place_on_own_car(q1,car43);
  assert res->>'status'='assigned', 'place_on_own_car: assigned';
  assert (select r.car_id=car43 and r.driver_id=m2 from public.rides r where r.id=(res->>'ride_id')::uuid), 'place_on_own_car: ride on the own car, owner drives';
  assert (select status::text from public.requests where id=q1)='assigned', 'place_on_own_car: request assigned';
  assert exists(select 1 from public.notifications where recipient_id=sadran and data->>'variant'='own_car_placed'), 'place_on_own_car: Sadran informed';
  perform pg_temp.expect_err(format('select public.place_on_own_car(%L,%L)',q1,car43),'request_not_editable');
  -- a second request overlapping the first: the car is not free
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,trip_type)
    values(dept,w,m2,m2,dest,typ,dt+interval '1 hour',dt+interval '2 hours','round_trip','waitlisted',home,'round_trip') returning id into q2;
  perform pg_temp.expect_err(format('select public.place_on_own_car(%L,%L)',q2,car43),'own_car_not_free');
  delete from public.requests where id=q2;

  -- ---- (f)(g) edit on a published day; overlaps in the submit response -----------------------------------------
  dt:=((w+5)+time '09:00') at time zone 'Asia/Jerusalem';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'depart_at',dt,'return_at',dt+interval '3 hours','trip_type','round_trip','adults',1));
  assert res->>'status'='assigned', format('setup edit: %s',res);
  q1:=(res->>'request_id')::uuid; rid:=(res->>'ride_id')::uuid;
  -- (g) the same member files an overlapping request: the response names the other request and ride
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'depart_at',dt+interval '1 hour','return_at',dt+interval '2 hours','trip_type','round_trip','adults',1));
  assert res->'warnings' ? 'DUPLICATE_OVERLAP', 'overlaps: DUPLICATE_OVERLAP warning';
  assert exists(select 1 from jsonb_array_elements(res->'overlaps') o where (o->>'request_id')::uuid=q1 and (o->>'ride_id')::uuid=rid),
    format('overlaps: names the other request and ride, got %s',res->'overlaps');
  q3:=(res->>'request_id')::uuid;
  -- withdrawing the overlapping one so the edit below is on a clean slate
  perform public.withdraw_request(q3,(select version from public.requests where id=q3));
  -- (f) edit to a later time: a plain car is free -> moved
  res:=public.submit_request(jsonb_build_object('request_id',q1,'expected_version',(select version from public.requests where id=q1),
    'department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'depart_at',dt+interval '4 hours','return_at',dt+interval '6 hours','trip_type','round_trip','adults',1));
  assert res->>'status'='assigned' and res ? 'ride_id' and (res->>'ride_id')::uuid<>rid, format('edit published: moved, got %s',res);
  assert (select status::text from public.rides where id=rid)='cancelled', 'edit published: the old booking is released';
  rid:=(res->>'ride_id')::uuid;
  -- (f) nothing free at the new time: ask first, change nothing
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    select dept,w,c,dt+interval '12 hours',dt+interval '13 hours',home,home,sadran,'confirmed',true,'SADRAN_MANUAL',sadran
    from unnest(array[car40,car41,car42]) c;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  res:=public.submit_request(jsonb_build_object('request_id',q1,'expected_version',(select version from public.requests where id=q1),
    'department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'depart_at',dt+interval '12 hours','return_at',dt+interval '13 hours','trip_type','round_trip','adults',1));
  assert res->>'needs_confirmation'='release_to_waitlist' and (res->>'drives_others')::boolean=false, format('edit published: asks first, got %s',res);
  assert (select status::text from public.rides where id=rid)='confirmed' and (select status::text from public.requests where id=q1)='assigned'
    and (select depart_at from public.requests where id=q1)=dt+interval '4 hours', 'edit published: needs_confirmation changes nothing';
  res:=public.submit_request(jsonb_build_object('request_id',q1,'expected_version',(select version from public.requests where id=q1),'confirm_release',true,
    'department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'depart_at',dt+interval '12 hours','return_at',dt+interval '13 hours','trip_type','round_trip','adults',1));
  assert res->>'status'='waitlisted', format('edit published: confirmed -> waiting list, got %s',res);
  assert (select status::text from public.rides where id=rid)='cancelled', 'edit published: old booking released on confirmation';
  -- a member who drives others is always asked, and the passengers keep a needs-driver ride
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  delete from public.rides where department_id=dept and week_start=w and pin_reason='SADRAN_MANUAL' and starts_at>=dt+interval '12 hours' and starts_at<dt+interval '24 hours';
  dt:=((w+6)+time '09:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,trip_type)
    values(dept,w,m1,m1,dest,typ,dt,dt+interval '3 hours','round_trip','assigned',home,'round_trip') returning id into q1;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,trip_type)
    values(dept,w,m2,m2,dest,typ,dt,dt+interval '3 hours','round_trip','merged',home,'round_trip') returning id into q2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car41,dt,dt+interval '3 hours',home,home,m1,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rid;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid,q1,'driver','both','keep');
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid,q2,'passenger','both','passenger');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  res:=public.submit_request(jsonb_build_object('request_id',q1,'expected_version',(select version from public.requests where id=q1),
    'department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'depart_at',dt+interval '5 hours','return_at',dt+interval '7 hours','trip_type','round_trip','adults',1));
  assert res->>'needs_confirmation'='release_to_waitlist' and (res->>'drives_others')::boolean, format('drives others: asks first, got %s',res);
  res:=public.submit_request(jsonb_build_object('request_id',q1,'expected_version',(select version from public.requests where id=q1),'confirm_release',true,
    'department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'depart_at',dt+interval '5 hours','return_at',dt+interval '7 hours','trip_type','round_trip','adults',1));
  assert (select needs_driver and driver_id is null and status<>'cancelled' from public.rides where id=rid), 'drives others: passengers keep a needs-driver ride';
  assert exists(select 1 from public.notifications where recipient_id=m2 and data->>'variant' in ('driver_cancelled','driver_cancelled_plain')), 'drives others: passenger told (QB6 path)';
  -- a passenger simply leaves; the driver is told
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  update public.rides set driver_id=m1,needs_driver=false,status='confirmed',flag_reason=null where id=rid;
  update public.requests set status='merged' where id=q2;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  res:=public.submit_request(jsonb_build_object('request_id',q2,'expected_version',(select version from public.requests where id=q2),'confirm_release',true,
    'department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'depart_at',dt+interval '9 hours','return_at',dt+interval '10 hours','trip_type','round_trip','adults',1));
  assert not exists(select 1 from public.ride_requests where ride_id=rid and request_id=q2), 'passenger edit: link removed';
  assert exists(select 1 from public.notifications where recipient_id=m1 and data->>'variant'='passenger_left'), 'passenger edit: driver told';
  -- closed and unpublished day keeps request_window_closed
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='solving',published_version_id=null where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  perform pg_temp.expect_err(format('select public.submit_request(%L::jsonb)',jsonb_build_object('request_id',q2,'expected_version',(select version from public.requests where id=q2),
    'department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,'depart_at',dt,'return_at',dt+interval '1 hour','trip_type','round_trip')::text),'request_window_closed');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);

  -- ---- QB14: add_ride_passengers names the ride's real destination -----------------------------------------------
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  dt:=((w+6)+time '15:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,trip_type)
    values(dept,w,m1,m1,dest,typ,dt,dt+interval '3 hours','round_trip','assigned',home,'round_trip') returning id into q1;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car42,dt,dt+interval '3 hours',home,home,m1,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rid;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rid,q1,'driver','both','keep');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  perform public.add_ride_passengers(rid,(select version from public.rides where id=rid),
    jsonb_build_array(jsonb_build_object('display_name','אורח','seat_kind','adult')));
  select body_he into v from public.notifications where recipient_id=m1 and data->>'variant'='passengers_added' order by created_at desc limit 1;
  assert v like '%'||dest_name||'%', format('QB14: notice must name the real destination %s, got %s',dest_name,v);

  -- ---- (i)/QF7: a freed car goes to the open contested group first ------------------------------------------------------
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);
  dt:=((w+2)+time '13:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,trip_type,status_reason)
    values(dept,w,m1,m1,dest,typ,dt,dt+interval '3 hours','round_trip','waitlisted',home,'round_trip','WAITLISTED_CONTESTED') returning id into q1;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,trip_type,status_reason)
    values(dept,w,m2,m2,dest,typ,dt,dt+interval '3 hours','round_trip','waitlisted',home,'round_trip','WAITLISTED_CONTESTED') returning id into q2;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,origin_id,trip_type,status_reason)
    values(dept,w,sadran,sadran,dest,typ,dt,dt+interval '3 hours','round_trip','waitlisted',home,'round_trip','WAITLISTED_NO_CAR') returning id into q3;
  g:=public.create_waitlist_group(dept,w,(w+2),array[q1,q2]);
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by,cancelled_at,cancelled_by,cancel_reason)
    values(dept,w,car40,dt,dt+interval '3 hours',home,home,sadran,'cancelled',true,'SADRAN_MANUAL',sadran,now(),sadran,'test') returning id into rid2;
  insert into public.freed_slot_offers(department_id,week_start,car_id,cancelled_ride_id,starts_at,ends_at,expires_at)
    values(dept,w,car40,rid2,dt,dt+interval '3 hours',dt) returning id into off;
  assert public.freed_slot_priority_requests(off)=array[q1,q2] or public.freed_slot_priority_requests(off)=array[q2,q1], 'QF7: the group''s requests are the priority ids';
  perform public.resolve_freed_offer(off,jsonb_build_array(
    jsonb_build_object('request_id',q3,'requester_id',sadran),jsonb_build_object('request_id',q1,'requester_id',m1),jsonb_build_object('request_id',q2,'requester_id',m2)));
  assert (select group_id=g and status='open' from public.freed_slot_offers where id=off), 'QF7: offer held for the group';
  assert not exists(select 1 from public.freed_slot_claims where offer_id=off), 'QF7: nobody else is offered the car meanwhile';
  assert exists(select 1 from public.notifications where recipient_id=m1 and event='waitlist_contested' and data->>'variant'='car_freed'), 'QF7: group member told a car was freed';
  assert not exists(select 1 from public.notifications where recipient_id=sadran and event='freed_slot'), 'QF7: the outsider is not offered it';
  -- the group resolves onto the freed car
  r:=public.resolve_waitlist_group(g,array[q1,q2],(select version from public.waitlist_groups where id=g));
  assert (r->>'car_id')::uuid=car40, format('QF7: the group takes the freed car, got %s',r);
  assert (select status::text from public.freed_slot_offers where id=off)='closed', 'QF7: offer closed once the group took the car';
  -- a group that is cancelled releases the offer back to the others
  delete from public.ride_requests where ride_id=(r->>'ride_id')::uuid;
  update public.rides set status='cancelled',cancelled_at=now(),cancelled_by=sadran,cancel_reason='test' where id=(r->>'ride_id')::uuid;
  perform set_config('app.system_status_transition','on',true);
  update public.requests set status='waitlisted',status_reason='WAITLISTED_CONTESTED' where id in (q1,q2);
  perform set_config('app.system_status_transition','off',true);
  g:=public.create_waitlist_group(dept,w,(w+2),array[q1,q2]);
  insert into public.freed_slot_offers(department_id,week_start,car_id,cancelled_ride_id,starts_at,ends_at,expires_at,group_id)
    values(dept,w,car40,rid2,dt,dt+interval '3 hours',dt,g) returning id into off;
  perform public.cancel_waitlist_group(g,(select version from public.waitlist_groups where id=g));
  assert (select group_id is null and status='open' from public.freed_slot_offers where id=off), 'QF7: a cancelled group releases the held offer';

  raise notice 'placement_features.sql: all assertions passed';
end $$;
rollback;
