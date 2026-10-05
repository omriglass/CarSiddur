-- REQ §13.96: a Sadran reservation ("שמירת זמן": a non-cancelled ride with no served request that is not an
-- automatic relocation) is location-neutral. It holds time on the car, but never moves it, never makes it "away",
-- never breaks a chain or a publication check, and its own places are never validated.
-- Transactional; rolled back at the end. Seeded נבו department, members …0102 (sadran) / …0103 / …0104,
-- home …0010, חיפה …0011, בנימינה …0012, ride type …0021, shared cars …0040/…0041.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  manager uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  haifa uuid:='00000000-0000-0000-0000-000000000011';
  binyamina uuid:='00000000-0000-0000-0000-000000000012';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  car1 uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+910;
  d date;
  qa uuid; qb uuid; q uuid; ra uuid; rb uuid; rr uuid; res jsonb; n_before int; n int; ids uuid[];
begin
  d:=w+1;
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '2 days',now()+interval '1 day',now()+interval '2 days');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);

  -- real ride A (08-10, home->home) and B (16-18), reservation R (12-14) labelled Haifa -> Binyamina in between
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,needs_car_at_destination,status)
    values(dept,w,m1,manager,home,haifa,typ,(d+time '08:00') at time zone 'Asia/Jerusalem',(d+time '10:00') at time zone 'Asia/Jerusalem','round_trip','round_trip',true,'assigned') returning id into qa;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by,is_pinned,pin_reason)
    values(dept,w,car1,(d+time '08:00') at time zone 'Asia/Jerusalem',(d+time '10:00') at time zone 'Asia/Jerusalem',home,home,m1,'draft',manager,true,'TEST') returning id into ra;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(ra,qa,'driver','both','keep');
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,needs_car_at_destination,status)
    values(dept,w,m1,manager,home,haifa,typ,(d+time '16:00') at time zone 'Asia/Jerusalem',(d+time '18:00') at time zone 'Asia/Jerusalem','round_trip','round_trip',true,'assigned') returning id into qb;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by,is_pinned,pin_reason)
    values(dept,w,car1,(d+time '16:00') at time zone 'Asia/Jerusalem',(d+time '18:00') at time zone 'Asia/Jerusalem',home,home,m1,'draft',manager,true,'TEST') returning id into rb;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rb,qb,'driver','both','keep');
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,created_by,is_pinned,pin_reason,notes)
    values(dept,w,car1,(d+time '12:00') at time zone 'Asia/Jerusalem',(d+time '14:00') at time zone 'Asia/Jerusalem',haifa,binyamina,null,'draft',manager,true,'RESERVATION','Haifa errand') returning id into rr;
  set constraints all immediate;   -- a reservation's differing places are accepted (rides_location_ends is a no-op)
  set constraints all deferred;

  -- 1) classification
  assert public.ride_is_reservation(rr), 'the manual ride is a reservation';
  assert not public.ride_is_reservation(ra) and not public.ride_is_reservation(rb), 'rides serving a request are not';

  -- 2) where the car is: ignores the reservation
  assert public.car_location_at(car1,(d+time '15:00') at time zone 'Asia/Jerusalem')=home, 'car_location_at after a reservation = location of the last real ride';
  assert public.car_location_at(car1,(d+time '12:30') at time zone 'Asia/Jerusalem')=home, 'car_location_at during a reservation = location of the last real ride';
  assert public.car_next_ride_origin(car1,(d+time '10:30') at time zone 'Asia/Jerusalem')=home, 'the next ride origin skips the reservation';

  -- 3) no chain break / healing ride, no away band
  select count(*) into n_before from public.rides where car_id=car1 and week_start=w and status<>'cancelled';
  perform public.assert_car_chain(car1,w);
  select count(*) into n from public.rides where car_id=car1 and week_start=w and status<>'cancelled';
  assert n=n_before and n=3, format('assert_car_chain adds no ride around a reservation (%s -> %s)',n_before,n);
  assert not exists(select 1 from public.v_car_locations where car_id=car1 and week_start=w), 'a reservation never makes the car away';

  -- 4) publication: no chain/overnight conflict for any of the three
  select array_agg(x) into ids from public.publication_conflicting_ride_ids(dept,w,array[d]) x;
  assert ids is null, format('no publication conflict around a reservation, got %s',ids);
  -- ... and it is judged neutral even when its own places are home-incompatible and it is the day's last ride
  update public.rides set status='cancelled',cancelled_at=now(),cancelled_by=manager,cancel_reason='TEST' where id=rb;
  select array_agg(x) into ids from public.publication_conflicting_ride_ids(dept,w,array[d]) x;
  assert ids is null, format('a trailing reservation away from home is no overnight conflict, got %s',ids);
  update public.rides set status='draft',cancelled_at=null,cancelled_by=null,cancel_reason=null where id=rb;

  -- 5) placement still respects TIME (overlap + turnaround) but not the reservation's places
  -- 10:30-11:30 fits between A and R (blocked until 12:00 = R's start)
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,needs_car_at_destination,status)
    values(dept,w,m2,manager,home,haifa,typ,(d+time '10:30') at time zone 'Asia/Jerusalem',(d+time '11:30') at time zone 'Asia/Jerusalem','round_trip','round_trip',true,'submitted') returning id into q;
  res:=public.try_auto_approve(q);
  assert res->>'status'='assigned' and (res->>'car_id')::uuid=car1, format('fits before the reservation on car1, got %s',res);
  -- 11:45-12:30 overlaps the reservation's time: never car1
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,needs_car_at_destination,status)
    values(dept,w,m2,manager,home,haifa,typ,(d+time '11:45') at time zone 'Asia/Jerusalem',(d+time '12:30') at time zone 'Asia/Jerusalem','round_trip','round_trip',true,'submitted') returning id into q;
  res:=public.try_auto_approve(q);
  assert coalesce((res->>'car_id')::uuid,'00000000-0000-0000-0000-000000000000') is distinct from car1, format('time overlap with the reservation is still refused, got %s',res);
  -- 14:30-15:15 starts after the reservation ended in "Binyamina": the car counts as at home, car1 takes it
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,needs_car_at_destination,status)
    values(dept,w,m2,manager,home,haifa,typ,(d+time '14:30') at time zone 'Asia/Jerusalem',(d+time '15:15') at time zone 'Asia/Jerusalem','round_trip','round_trip',true,'submitted') returning id into q;
  res:=public.try_auto_approve(q);
  assert res->>'status'='assigned' and (res->>'car_id')::uuid=car1, format('the reservation''s places do not decide where the car is, got %s',res);
  -- turnaround before B (16:00): 15:30-15:45 would block until 16:15
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,needs_car_at_destination,status)
    values(dept,w,m1,manager,home,haifa,typ,(d+time '15:30') at time zone 'Asia/Jerusalem',(d+time '15:45') at time zone 'Asia/Jerusalem','round_trip','round_trip',true,'submitted') returning id into q;
  res:=public.try_auto_approve(q);
  assert coalesce((res->>'car_id')::uuid,'00000000-0000-0000-0000-000000000000') is distinct from car1, format('turnaround still counts, got %s',res);

  set constraints all immediate;
  raise notice 'reservations_neutral.sql: all assertions passed';
end $$;
rollback;
