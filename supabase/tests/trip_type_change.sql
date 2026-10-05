-- REQ §13.95 H3: set_request_trip_type() -- the Sadran changes a request's trip type directly.
--   derived legacy fields, re-placement on the car the request was on, unmet when it no longer fits,
--   requester notification (outcome_changed / trip_type_changed + tripType fragment), refusals.
-- Transactional; rolled back at the end.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  haifa uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car1 uuid:='00000000-0000-0000-0000-000000000040';
  car2 uuid:='00000000-0000-0000-0000-000000000041';
  w date:=public.current_week_start()+840;
  q uuid; q2 uuid; q3 uuid; ride uuid; x uuid; v int; res jsonb; r record; n int; frag text;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);

  -- 1) round_trip on car1 -> drop_off: keeps the return as the pickup, re-placed on car1; the requester
  --    drives, so the two legs connect (REQ §13.95 H2) as relay legs.
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,needs_car_at_destination,status)
    values(dept,w,m1,manager,home,haifa,typ,(w+1+time '08:00') at time zone 'Asia/Jerusalem',(w+1+time '12:00') at time zone 'Asia/Jerusalem','round_trip','round_trip',true,'assigned') returning id into q;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by,is_pinned,pin_reason)
    values(dept,w,car1,(w+1+time '08:00') at time zone 'Asia/Jerusalem',(w+1+time '12:00') at time zone 'Asia/Jerusalem',home,home,m1,'draft',manager,true,'TEST') returning id into ride;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(ride,q,'driver','both','keep');
  select version into v from public.requests where id=q;

  -- refusals first
  begin perform public.set_request_trip_type(q,'drop_off',v+7); raise exception 'stale must be refused';
  exception when others then if sqlstate<>'P0409' then raise; end if; end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  begin perform public.set_request_trip_type(q,'drop_off',v); raise exception 'a member must be refused';
  exception when others then if sqlerrm<>'not_authorized' then raise; end if; end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  res:=public.set_request_trip_type(q,'round_trip',v);
  assert (res->>'changed')::boolean=false, 'same trip type is a no-op';

  res:=public.set_request_trip_type(q,'drop_off',v);
  select * into r from public.requests where id=q;
  assert r.trip_type='drop_off' and r.trip_shape='round_trip' and r.needs_car_at_destination=false and r.one_way_car_mode is null
     and r.return_at=(w+1+time '12:00') at time zone 'Asia/Jerusalem', 'drop_off keeps the return as the pickup; legacy fields derived';
  assert r.version>v, 'request version bumped';
  assert res->>'status'='assigned' and res->>'ride_id' is not null, format('re-placed and assigned, got %s',res);
  assert (select status from public.rides where id=ride)='cancelled', 'old ride replaced';
  select count(*) into n from public.ride_requests rr join public.rides d on d.id=rr.ride_id
    where rr.request_id=q and d.status<>'cancelled' and d.car_id=car1;
  assert n=2, format('two legs on the same car, got %s',n);
  assert (select count(*) from public.ride_requests rr join public.rides d on d.id=rr.ride_id where rr.request_id=q and d.status<>'cancelled' and rr.car_mode='relay' and d.driver_id=m1)=2,
    'the driving requester''s legs are connected relay legs';
  select body into frag from public.text_fragments where key='trip_type.drop_off';
  assert exists(select 1 from public.notifications where recipient_id=m1 and event='outcome_changed' and data->>'variant'='trip_type_changed'
                and data->>'request_id'=q::text and body_he like '%'||frag||'%' and body_he not like '%{{%'),
    'requester notified with the trip type name rendered';

  -- 2) drop_off -> one_way: the return is cleared, one relay out leg on the same car
  select version into v from public.requests where id=q;
  res:=public.set_request_trip_type(q,'one_way',v);
  select * into r from public.requests where id=q;
  assert r.trip_type='one_way' and r.trip_shape='one_way_to' and r.return_at is null and r.needs_car_at_destination and r.one_way_car_mode='relay', 'one_way derived fields';
  assert res->>'status'='assigned', format('one_way re-placed, got %s',res);
  select d.* into r from public.rides d join public.ride_requests rr on rr.ride_id=d.id where rr.request_id=q and d.status<>'cancelled';
  assert r.car_id=car1 and r.origin_id=home and r.destination_id=haifa and r.driver_id=m1, 'relay out leg home -> Haifa on the same car, requester drives';
  assert (select count(*) from public.ride_requests rr join public.rides d on d.id=rr.ride_id where rr.request_id=q and d.status<>'cancelled')=1, 'one live ride';

  -- 3) one_way -> round_trip needs a return time (neither a stored one nor a kept one)
  update public.requests set kept_return_at=null where id=q;
  select version into v from public.requests where id=q;
  begin perform public.set_request_trip_type(q,'round_trip',v); raise exception 'round_trip without return must be refused';
  exception when others then if sqlerrm<>'trip_type_needs_return' then raise; end if; end;

  -- 4) non-driver without companion: only drop_off
  update public.profiles set does_not_drive=true where id=m2;
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,needs_car_at_destination,status)
    values(dept,w,m2,manager,home,haifa,typ,(w+2+time '08:00') at time zone 'Asia/Jerusalem',(w+2+time '12:00') at time zone 'Asia/Jerusalem','round_trip','drop_off',false,'submitted') returning id into q2;
  select version into v from public.requests where id=q2;
  begin perform public.set_request_trip_type(q2,'round_trip',v); raise exception 'non-driver round_trip must be refused';
  exception when others then if sqlerrm<>'non_driver_needs_drop_off' then raise; end if; end;
  begin perform public.set_request_trip_type(q2,'one_way',v); raise exception 'non-driver one_way must be refused';
  exception when others then if sqlerrm<>'non_driver_needs_drop_off' then raise; end if; end;
  update public.profiles set does_not_drive=false where id=m2;

  -- 5) no longer fits: the car stands in Haifa when the one_way leg would leave home -> unmet
  -- (a real relay leg: a ride serving no request would be a reservation, which never moves the car -- REQ §13.96)
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,one_way_car_mode,needs_car_at_destination,status)
    values(dept,w,m2,manager,home,haifa,typ,(w+3+time '07:00') at time zone 'Asia/Jerusalem','one_way_to','one_way','relay',true,'assigned') returning id into q2;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by,is_pinned,pin_reason)
    values(dept,w,car2,(w+3+time '07:00') at time zone 'Asia/Jerusalem',(w+3+time '07:30') at time zone 'Asia/Jerusalem',home,haifa,m2,'draft',manager,true,'TEST') returning id into x;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(x,q2,'driver','out','relay');
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,needs_car_at_destination,status)
    values(dept,w,m1,manager,home,haifa,typ,(w+3+time '09:00') at time zone 'Asia/Jerusalem',(w+3+time '12:00') at time zone 'Asia/Jerusalem','round_trip','round_trip',true,'assigned') returning id into q3;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by,is_pinned,pin_reason)
    values(dept,w,car2,(w+3+time '09:00') at time zone 'Asia/Jerusalem',(w+3+time '12:00') at time zone 'Asia/Jerusalem',home,home,m1,'draft',manager,true,'TEST') returning id into x;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(x,q3,'driver','both','keep');
  select version into v from public.requests where id=q3;
  res:=public.set_request_trip_type(q3,'one_way',v);
  assert res->>'status'='submitted' and res->>'ride_id' is null, format('returned to unmet, got %s',res);
  assert (select status_reason from public.requests where id=q3)='UNMET_TRIP_TYPE_CHANGED', 'unmet reason';
  assert (select status from public.rides where id=x)='cancelled', 'its ride is released';
  assert not exists(select 1 from public.ride_requests rr join public.rides d on d.id=rr.ride_id where rr.request_id=q3 and d.status<>'cancelled'), 'no live ride left';
  assert (select trip_type from public.requests where id=q3)='one_way', 'the new trip type is kept';

  -- 6) kept_return_at: round trip -> one_way -> round_trip restores the exact return time (set_request_trip_type)
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,needs_car_at_destination,status,flex_return_late)
    values(dept,w,m1,manager,home,haifa,typ,(w+4+time '08:00') at time zone 'Asia/Jerusalem',(w+4+time '12:15') at time zone 'Asia/Jerusalem','round_trip','round_trip',true,'submitted','30 min') returning id into q;
  select version into v from public.requests where id=q;
  perform public.set_request_trip_type(q,'one_way',v);
  select * into r from public.requests where id=q;
  assert r.return_at is null and r.kept_return_at=(w+4+time '12:15') at time zone 'Asia/Jerusalem', 'one_way keeps the return in kept_return_at';
  assert r.flex_return_late='30 min', 'flex_return_* untouched';
  perform public.set_request_trip_type(q,'drop_off',r.version);
  select * into r from public.requests where id=q;
  assert r.return_at is null and r.kept_return_at is not null, 'drop_off without a pickup still remembers the return';
  res:=public.set_request_trip_type(q,'round_trip',r.version);
  select * into r from public.requests where id=q;
  assert r.return_at=(w+4+time '12:15') at time zone 'Asia/Jerusalem' and r.kept_return_at is null and r.trip_shape='round_trip', 'round_trip restores the exact return time';
  assert (res->>'restored_return_at')::timestamptz=(w+4+time '12:15') at time zone 'Asia/Jerusalem', 'the result reports the restored return time';

  -- 7) the same through submit_request edits
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'requester_id',m1,'destination_id',haifa,'origin_id',home,
    'ride_type_id',typ,'trip_type','round_trip','depart_at',(w+5+time '08:00') at time zone 'Asia/Jerusalem','return_at',(w+5+time '13:30') at time zone 'Asia/Jerusalem'));
  q:=(res->>'request_id')::uuid;
  select version into v from public.requests where id=q;
  res:=public.submit_request(jsonb_build_object('request_id',q,'expected_version',v,'department_id',dept,'week_start',w,'requester_id',m1,'destination_id',haifa,'origin_id',home,
    'ride_type_id',typ,'trip_type','one_way','depart_at',(w+5+time '08:00') at time zone 'Asia/Jerusalem'));
  select * into r from public.requests where id=q;
  assert r.return_at is null and r.kept_return_at=(w+5+time '13:30') at time zone 'Asia/Jerusalem', 'submit_request edit to one_way keeps the return';
  res:=public.submit_request(jsonb_build_object('request_id',q,'expected_version',r.version,'department_id',dept,'week_start',w,'requester_id',m1,'destination_id',haifa,'origin_id',home,
    'ride_type_id',typ,'trip_type','one_way','depart_at',(w+5+time '09:00') at time zone 'Asia/Jerusalem'));
  select * into r from public.requests where id=q;
  assert r.kept_return_at=(w+5+time '13:30') at time zone 'Asia/Jerusalem', 'a second one-way edit keeps it';
  res:=public.submit_request(jsonb_build_object('request_id',q,'expected_version',r.version,'department_id',dept,'week_start',w,'requester_id',m1,'destination_id',haifa,'origin_id',home,
    'ride_type_id',typ,'trip_type','round_trip','depart_at',(w+5+time '09:00') at time zone 'Asia/Jerusalem'));
  select * into r from public.requests where id=q;
  assert r.return_at=(w+5+time '13:30') at time zone 'Asia/Jerusalem' and r.kept_return_at is null, 'switching back without a return restores it and clears the kept one';
  res:=public.submit_request(jsonb_build_object('request_id',q,'expected_version',r.version,'department_id',dept,'week_start',w,'requester_id',m1,'destination_id',haifa,'origin_id',home,
    'ride_type_id',typ,'trip_type','one_way','depart_at',(w+5+time '09:00') at time zone 'Asia/Jerusalem'));
  select * into r from public.requests where id=q;
  res:=public.submit_request(jsonb_build_object('request_id',q,'expected_version',r.version,'department_id',dept,'week_start',w,'requester_id',m1,'destination_id',haifa,'origin_id',home,
    'ride_type_id',typ,'trip_type','round_trip','depart_at',(w+5+time '09:00') at time zone 'Asia/Jerusalem','return_at',(w+5+time '15:00') at time zone 'Asia/Jerusalem'));
  select * into r from public.requests where id=q;
  assert r.return_at=(w+5+time '15:00') at time zone 'Asia/Jerusalem' and r.kept_return_at is null, 'a real return replaces the kept one';
  assert exists(select 1 from public.v_my_requests where request_id=q and kept_return_at is null), 'v_my_requests exposes kept_return_at';

  -- 8) REQ §13.97: switching trip type never deletes information -- a return-leg stop is kept (inactive)
  --    while the request has no return and active again, same position, when the return comes back.
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'requester_id',m1,'destination_id',haifa,'origin_id',home,
    'ride_type_id',typ,'trip_type','round_trip','depart_at',(w+6+time '08:00') at time zone 'Asia/Jerusalem','return_at',(w+6+time '13:00') at time zone 'Asia/Jerusalem',
    'stops',jsonb_build_array(jsonb_build_object('leg','return','place_id',home))));
  q:=(res->>'request_id')::uuid;
  assert (select count(*) from public.request_leg_route_points(q,'return'))=3, 'active return stop is a route point';
  assert exists(select 1 from public.request_stop_etas(q) where leg='return'), 'active return stop has an ETA';
  assert exists(select 1 from public.request_stops_with_eta(q) where leg='return' and active and "position"=1), 'stop reported active';
  -- via set_request_trip_type
  select version into v from public.requests where id=q;
  perform public.set_request_trip_type(q,'one_way',v);
  assert exists(select 1 from public.request_stops where request_id=q and leg='return' and "position"=1), 'stop kept after switching to one_way';
  assert (select count(*) from public.request_leg_route_points(q,'return'))=2, 'inactive stop not a route point';
  assert not exists(select 1 from public.request_stop_etas(q) where leg='return'), 'inactive stop has no ETA';
  assert exists(select 1 from public.request_stops_with_eta(q) where leg='return' and not active and eta is null), 'stop reported inactive';
  select version into v from public.requests where id=q;
  perform public.set_request_trip_type(q,'round_trip',v);
  assert exists(select 1 from public.request_stops where request_id=q and leg='return' and "position"=1), 'stop still there';
  assert (select count(*) from public.request_leg_route_points(q,'return'))=3, 'stop active again';
  assert exists(select 1 from public.request_stops_with_eta(q) where leg='return' and active and "position"=1), 'stop active again, same position';
  -- via submit_request edits (payload without stops leaves them untouched)
  select version into v from public.requests where id=q;
  perform public.submit_request(jsonb_build_object('request_id',q,'expected_version',v,'department_id',dept,'week_start',w,'requester_id',m1,'destination_id',haifa,'origin_id',home,
    'ride_type_id',typ,'trip_type','one_way','depart_at',(w+6+time '08:00') at time zone 'Asia/Jerusalem'));
  assert exists(select 1 from public.request_stops_with_eta(q) where leg='return' and not active), 'submit_request one-way edit keeps the stop inactive';
  select version into v from public.requests where id=q;
  perform public.submit_request(jsonb_build_object('request_id',q,'expected_version',v,'department_id',dept,'week_start',w,'requester_id',m1,'destination_id',haifa,'origin_id',home,
    'ride_type_id',typ,'trip_type','round_trip','depart_at',(w+6+time '08:00') at time zone 'Asia/Jerusalem'));
  assert exists(select 1 from public.request_stops_with_eta(q) where leg='return' and active and "position"=1), 'submit_request round-trip edit: stop active again';
  -- a payload carrying the complete list replaces both legs
  select version into v from public.requests where id=q;
  perform public.submit_request(jsonb_build_object('request_id',q,'expected_version',v,'department_id',dept,'week_start',w,'requester_id',m1,'destination_id',haifa,'origin_id',home,
    'ride_type_id',typ,'trip_type','one_way','depart_at',(w+6+time '08:00') at time zone 'Asia/Jerusalem','stops','[]'::jsonb));
  assert not exists(select 1 from public.request_stops where request_id=q), 'empty stops array clears both legs';


  raise notice 'trip_type_change.sql: all assertions passed';
end $$;
rollback;
