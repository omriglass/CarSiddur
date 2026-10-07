-- QA run 6, group F (car location / shape): R6B4 (a trip-type change places only where the car is), R6B6 (a driverless car
-- move still decides where the car is), R6B11 (moving a chauffeur leg to another car keeps its shape) and REQ §13.105 d
-- (fewer days down to the last day sends real times). Transactional; rolled back. Seeded נבו department.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  home uuid:='00000000-0000-0000-0000-000000000010';
  haifa uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car40 uuid:='00000000-0000-0000-0000-000000000040';
  car41 uuid:='00000000-0000-0000-0000-000000000041';
  car42 uuid:='00000000-0000-0000-0000-000000000042';
  w date:=public.current_week_start()+1295;
  d timestamptz; q uuid; prop uuid; tokens jsonb; res jsonb; sid uuid; ride_out uuid; ride_ret uuid; ver int; mv uuid; code text;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  update public.department_settings set auto_apply_accepted_proposals=true where department_id=dept;

  -- ============ R6B4: a round trip is placed only on a car standing at the request's origin
  d:=((w+2)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    values(dept,w,m1,manager,home,haifa,typ,d,d+interval '6 hours','round_trip','drop_off','submitted') returning id into q;
  perform public.place_request_on_car(q,car40,true,manager,null,d,d+interval '6 hours','TEST');
  -- the car is left in Haifa the day before (a Sadran car move), so on Tuesday it is not at home
  perform public.mark_car_move(car40,home,haifa,((w+1)+time '08:00') at time zone 'Asia/Jerusalem',60,'{}');
  assert public.car_location_at(car40,d)=haifa, 'R6B4 setup: the car stands in Haifa on Tuesday';
  begin
    perform public.place_request_on_car(q,car40,true,manager,null,d,d+interval '6 hours','TEST');
    -- (a drop_off places by chauffeur candidates; the round-trip branch is exercised through the trip-type change below)
  exception when others then null; end;
  perform public.set_request_trip_type(q,'round_trip',(select version from public.requests where id=q));
  assert (select status from public.requests where id=q)<>'assigned' or not exists(
      select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id
      where rr.request_id=q and r.status<>'cancelled' and r.car_id=car40 and r.origin_id=home and r.starts_at=d),
    'R6B4: the request is never put on a car standing in Haifa as a round trip from home';
  assert (select status_reason from public.requests where id=q)='UNMET_TRIP_TYPE_CHANGED',
    format('R6B4: the request stays unmet, got %s',(select status_reason from public.requests where id=q));

  -- ============ R6B6: a driverless car move is still a ride that decides where the car is (and what comes next)
  mv:=public.mark_car_move(car41,home,haifa,((w+4)+time '08:00') at time zone 'Asia/Jerusalem',60,'{}');
  assert (select auto_relocation and pin_reason='CAR_MOVE' and driver_id is null from public.rides where id=mv), 'R6B6 setup: a driverless car move';
  assert public.car_next_ride_origin(car41,((w+4)+time '06:00') at time zone 'Asia/Jerusalem')=home,
    'R6B6: the next ride after 06:00 is the car move, leaving home';
  assert public.car_location_at(car41,((w+4)+time '12:00') at time zone 'Asia/Jerusalem')=haifa, 'R6B6: after the move the car is in Haifa';
  perform public.mark_car_move(car41,haifa,home,((w+4)+time '12:00') at time zone 'Asia/Jerusalem',60,'{}');
  assert public.car_location_at(car41,((w+4)+time '18:00') at time zone 'Asia/Jerusalem')=home, 'R6B6: a car move back to base puts the car home';

  -- ============ R6B11: moving one chauffeur leg to the car that holds the other leg does not connect them
  d:=((w+5)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status,status_reason)
    values(dept,w,m1,manager,home,haifa,typ,d,d+interval '7 hours 30 minutes','round_trip','drop_off','waitlisted','UNMET_NEEDS_DRIVER') returning id into q;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,needs_driver,status,is_pinned,pin_reason,created_by)
    values(dept,w,car41,d,d+interval '1 hour 30 minutes',home,home,true,'draft',true,'MISSING_DRIVER',manager) returning id into ride_out;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,needs_driver,status,is_pinned,pin_reason,created_by)
    values(dept,w,car42,d+interval '6 hours',d+interval '7 hours 30 minutes',home,home,true,'draft',true,'MISSING_DRIVER',manager) returning id into ride_ret;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(ride_out,q,'passenger','out','chauffeur'),(ride_ret,q,'passenger','return','chauffeur');
  -- the long wait (10:00-14:00) is needed elsewhere: as many other open requests as shared cars overlap it
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,status)
    select dept,w,m1,manager,home,haifa,typ,d+interval '3 hours',d+interval '5 hours','round_trip','round_trip','submitted'
    from generate_series(1,(select count(*) from public.cars where department_id=dept and status='active' and type='shared'));
  select version into ver from public.rides where id=ride_ret;
  perform public.edit_ride(jsonb_build_object('id',ride_ret,'department_id',dept,'week_start',w,'car_id',car41,
    'starts_at',d+interval '6 hours','ends_at',d+interval '7 hours 30 minutes','needs_driver',true,'pin_reason','SADRAN_MANUAL'),ver);   -- the board echoes the ride's own pin reason (a manual one would waive the demand rule)
  assert (select car_id=car41 from public.rides where id=ride_ret), 'R6B11: the pickup ride moved to the other car';
  assert (select count(*)=2 from public.ride_requests where request_id=q and car_mode='chauffeur'),
    'R6B11: the wait is needed elsewhere, so a move does not connect the legs (a manual pin reason is no waiver)';
  assert (select needs_driver and driver_id is null from public.rides where id=ride_out) and (select needs_driver and driver_id is null from public.rides where id=ride_ret),
    'R6B11: both rides still need a driver; the requester was not made the driver';
  assert (select status from public.rides where id=ride_out)<>'cancelled' and (select status from public.rides where id=ride_ret)<>'cancelled', 'R6B11: neither ride was merged away';

  -- ============ 105 d: fewer days down to the LAST day sends and places the real times
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  res:=public.submit_series_request(jsonb_build_object(
    'department_id',dept,'week_start',w,'destination_id',haifa,'ride_type_id',typ,'trip_shape','round_trip','adults',1,
    'depart_at',((w+1)+time '07:00') at time zone 'Asia/Jerusalem','return_at',((w+3)+time '17:00') at time zone 'Asia/Jerusalem'));
  sid:=(res->>'series_id')::uuid;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  q:=(select id from public.requests where series_id=sid and series_index=1);
  -- the last day alone, as the old composer sent it: the held-day 00:00 start
  prop:=public.create_proposal(q,null,'shift',jsonb_build_object('car_id',car42,'series_span',jsonb_build_object(
    'depart_at',((w+3)+time '00:00') at time zone 'Asia/Jerusalem','return_at',((w+3)+time '17:00') at time zone 'Asia/Jerusalem')),'x');
  tokens:=public.send_proposal(prop,'{}');
  perform public.answer_proposal(tokens->'party_tokens'->>m1::text,true);
  assert (select status from public.proposals where id=prop)='applied', format('105d: the last-day span applies, got %s',(select status from public.proposals where id=prop));
  select id into q from public.requests where department_id=dept and week_start=w and series_id is null and status='assigned'
    and (depart_at at time zone 'Asia/Jerusalem')::date=w+3;
  assert q is not null, '105d: the kept last day is an ordinary assigned request';
  assert (select (depart_at at time zone 'Asia/Jerusalem')::time=time '07:00' and (return_at at time zone 'Asia/Jerusalem')::time=time '17:00' from public.requests where id=q),
    format('105d: the kept day leaves at the series'' real 07:00 and returns 17:00, got %s-%s',
      (select depart_at at time zone 'Asia/Jerusalem' from public.requests where id=q),(select return_at at time zone 'Asia/Jerusalem' from public.requests where id=q));
  assert exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q and r.status<>'cancelled' and r.car_id=car42
    and (r.starts_at at time zone 'Asia/Jerusalem')::date=w+3),
    '105d: the kept day is placed on the chosen car on its own day';
end $$;
rollback;
