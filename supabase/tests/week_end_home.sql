-- REQ §13.136 (c), SQL side: an AUTOMATIC placement never leaves a shared car away from its base with nothing
-- bringing it back (try_auto_approve one-way branch, place_request_on_car one-way for non-manual callers).
-- A manual Sadran placement and an accepted proposal (PROPOSAL_APPLIED) stay allowed. Transactional.
-- Seeded department …0001 (home …0010), manager …0102, members …0103/…0104, haifa …0011, cars …0040/41/42.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  member2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  car1 uuid := '00000000-0000-0000-0000-000000000040';
  car2 uuid := '00000000-0000-0000-0000-000000000041';
  car3 uuid := '00000000-0000-0000-0000-000000000042';
  w date := public.current_week_start() + 910;   -- far-future Sunday, collides with no other suite
  v_result jsonb; v_ride record; qid uuid; v_pq uuid; v_pr uuid; pub uuid;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', manager) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_at = now()
    where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);

  -- car_week_end_ok itself
  assert public.car_week_end_ok(car1, (w+1+time '08:00') at time zone 'Asia/Jerusalem', home), '0) the base with no next ride is fine';
  assert not public.car_week_end_ok(car1, (w+1+time '08:00') at time zone 'Asia/Jerusalem', haifa), '0) a non-base place with no next ride is not';

  -- 1) one-way home -> haifa, nothing brings the car back: stays waitlisted.
  v_result := public.submit_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'requester_id', member1, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_type', 'one_way', 'depart_at', (w+2+time '08:00') at time zone 'Asia/Jerusalem'));
  assert v_result ->> 'status' = 'waitlisted', '1) an automatic one-way that strands the car away from base must not be placed';
  assert not exists(select 1 from public.ride_requests where request_id = (v_result ->> 'request_id')::uuid), '1) no booking';

  -- 2) the same trip with a later ride on car …0040 that starts at haifa: placed (on that car).
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,return_at,trip_shape,trip_type,needs_car_at_destination,status)
    values(dept,w,manager,manager,haifa,home,ride_type,(w+2+time '20:00') at time zone 'Asia/Jerusalem',(w+2+time '21:00') at time zone 'Asia/Jerusalem','round_trip','round_trip',true,'assigned') returning id into v_pq;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,car1,(w+2+time '20:00') at time zone 'Asia/Jerusalem',(w+2+time '21:00') at time zone 'Asia/Jerusalem',haifa,haifa,manager,'confirmed',true,'TEST_BLOCKER',manager) returning id into v_pr;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(v_pr,v_pq,'driver','both','keep');
  v_result := public.submit_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'requester_id', member2, 'destination_id', haifa, 'ride_type_id', ride_type,
    'trip_type', 'one_way', 'depart_at', (w+2+time '08:00') at time zone 'Asia/Jerusalem'));
  assert v_result ->> 'status' = 'assigned' and (v_result ->> 'car_id')::uuid = car1, '2) a later ride starting at the destination allows the one-way';

  -- 3) one-way back to the base (car …0040 stands at haifa after the evening ride): placed.
  v_result := public.submit_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'requester_id', member1, 'origin_id', haifa, 'destination_id', home, 'ride_type_id', ride_type,
    'trip_type', 'one_way', 'depart_at', (w+3+time '08:00') at time zone 'Asia/Jerusalem'));
  assert v_result ->> 'status' = 'assigned' and (v_result ->> 'car_id')::uuid = car1, '3) a one-way that returns the car to its base is placed';

  -- 4) place_request_on_car: automatic refuses, manual and an accepted proposal pass.
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,one_way_car_mode,needs_car_at_destination,status)
    values(dept,w,member1,manager,home,haifa,ride_type,(w+4+time '08:00') at time zone 'Asia/Jerusalem','one_way_to','one_way','relay',false,'submitted') returning id into qid;
  begin
    perform public.place_request_on_car(qid, car2, false, manager, null, null, null, 'AUTO_APPROVED_FREE_CAR');
    raise exception 'expected car_week_end_away';
  exception when others then
    if sqlerrm <> 'car_week_end_away' then raise; end if;
  end;
  assert not exists(select 1 from public.ride_requests where request_id = qid), '4) the refused placement left no booking';
  perform public.place_request_on_car(qid, car2, true, manager, null, null, null, 'SADRAN_MANUAL');
  assert (select status from public.requests where id = qid) = 'assigned', '4) a manual Sadran placement is still allowed';
  -- an accepted proposal (non-manual, reason PROPOSAL_APPLIED) is a human decision
  insert into public.requests(department_id,week_start,requester_id,filed_by,origin_id,destination_id,ride_type_id,depart_at,trip_shape,trip_type,one_way_car_mode,needs_car_at_destination,status)
    values(dept,w,member2,manager,home,haifa,ride_type,(w+5+time '08:00') at time zone 'Asia/Jerusalem','one_way_to','one_way','relay',false,'submitted') returning id into qid;
  perform public.place_request_on_car(qid, car3, false, manager, null, null, null, 'PROPOSAL_APPLIED');
  assert (select status from public.requests where id = qid) = 'assigned', '4) an applied proposal is still allowed';
end $$;

rollback;
