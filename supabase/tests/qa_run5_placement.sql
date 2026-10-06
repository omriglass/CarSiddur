-- QA run 5 placement fixes (REQ §13.105; docs/TODO.md R5B2/R5B8/R5Q1/R5Q2). Transactional, seeded נבו on a far-future week.
--  R5B2  a chauffeur ride from a car parked away from both ends of the leg (place = the car's place) is accepted by the leg-location check
--  R5Q2  placing a pickup (return leg) from X on a car standing at X is one relay ride X -> origin, the requester drives
--  R5B8  the connected pair of a short הקפצה by a member who drives ignores "wait needed elsewhere" (wait <= 2 x turnaround)
begin;
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  dest uuid := '00000000-0000-0000-0000-000000000011';   -- חיפה
  elsewhere uuid := '00000000-0000-0000-0000-000000000012';   -- בנימינה
  typ uuid := '00000000-0000-0000-0000-000000000021';
  carA uuid := '00000000-0000-0000-0000-000000000040';
  carB uuid := '00000000-0000-0000-0000-000000000041';
  w date := public.current_week_start() + 413;
  d date := (public.current_week_start() + 413) + 2;
  t0 timestamptz := (d + time '00:00') at time zone 'Asia/Jerusalem';
  q uuid; q0 uuid; r uuid; r0 uuid; v_n int; k int;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
  values (dept, w, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');
  update public.profiles set does_not_drive = false where id in (m1, m2);

  ---------------------------------------------------------------- R5B2
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id,
      trip_type, trip_shape, one_way_car_mode, needs_car_at_destination, depart_at, status)
    values (dept, w, m1, manager, home, dest, typ, 'drop_off', 'one_way_to', 'passenger', false, t0 + interval '8 hours', 'submitted') returning id into q;
  insert into public.rides(department_id, week_start, car_id, driver_id, needs_driver, origin_id, destination_id, created_by,
      starts_at, ends_at, status)
    values (dept, w, carA, null, true, elsewhere, elsewhere, manager, t0 + interval '7 hours 30 minutes', t0 + interval '9 hours 30 minutes', 'draft') returning id into r;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r, q, 'passenger', 'out', 'chauffeur');
  assert exists (select 1 from public.ride_requests where ride_id = r and car_mode = 'chauffeur'),
    'R5B2: a chauffeur ride at the car''s own (third) place must be accepted';
  -- origin <> destination is still not a chauffeur loop
  begin
    insert into public.rides(department_id, week_start, car_id, driver_id, needs_driver, origin_id, destination_id, created_by,
        starts_at, ends_at, status)
      values (dept, w, carB, null, true, elsewhere, home, manager, t0 + interval '7 hours', t0 + interval '8 hours', 'draft') returning id into r0;
    insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r0, q, 'passenger', 'out', 'chauffeur');
    assert false, 'R5B2: a chauffeur ride that ends elsewhere must be refused';
  exception when others then
    assert sqlerrm = 'leg_location_mismatch', 'R5B2: expected leg_location_mismatch, got ' || sqlerrm;
  end;
  delete from public.ride_requests where request_id = q;
  delete from public.rides where id in (r, r0);
  delete from public.requests where id = q;

  ---------------------------------------------------------------- R5Q2
  -- carB is parked at dest (a one-way ride of another member took it there at 06:00-07:00).
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id,
      trip_type, trip_shape, one_way_car_mode, depart_at, status)
    values (dept, w, m2, manager, home, dest, typ, 'one_way', 'one_way_to', 'relay', t0 + interval '6 hours', 'assigned') returning id into q0;
  insert into public.rides(department_id, week_start, car_id, driver_id, origin_id, destination_id, created_by, starts_at, ends_at, status)
    values (dept, w, carB, m2, home, dest, manager, t0 + interval '6 hours', t0 + interval '7 hours', 'draft') returning id into r0;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r0, q0, 'driver', 'out', 'relay');
  assert public.car_location_at(carB, t0 + interval '10 hours') = dest, 'setup: carB stands at the destination';

  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id,
      trip_type, trip_shape, needs_car_at_destination, depart_at, return_at, status)
    values (dept, w, m1, manager, home, dest, typ, 'drop_off', 'round_trip', false, t0 + interval '8 hours', t0 + interval '15 hours', 'submitted') returning id into q;
  perform set_config('app.place_only_leg', 'return', true);
  r := public.place_request_on_car(q, carB, true, manager, null, null, null, 'TEST');
  perform set_config('app.place_only_leg', '', true);
  assert r is not null, 'R5Q2: the pickup is placed';
  assert (select rd.origin_id = dest and rd.destination_id = home and rd.driver_id = m1 and not rd.needs_driver and rd.car_id = carB
          from public.rides rd where rd.id = r), 'R5Q2: one ride X -> origin on the car at X, the requester drives';
  assert (select rr.car_mode = 'relay' and rr.leg = 'return' and rr.role = 'driver' from public.ride_requests rr where rr.ride_id = r and rr.request_id = q),
    'R5Q2: relay return leg, driver role';
  assert (select status = 'assigned' from public.requests where id = q), 'R5Q2: the request is assigned, not waiting for a volunteer';
  assert public.car_location_at(carB, t0 + interval '16 hours') = home, 'R5Q2: the car is home afterwards';

  -- a named volunteer driver is the Sadran's decision: the pickup is never turned into a relay ride (the chauffeur wrap
  -- needs the car at the request's origin, so with the car at X it is refused as before)
  update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = manager, cancel_reason = 'test' where id = r;
  delete from public.ride_requests where ride_id = r;
  perform set_config('app.place_only_leg', 'return', true);
  begin
    perform public.place_request_on_car(q, carB, true, manager, m2, null, null, 'TEST');
    assert false, 'R5Q2: a named driver must not get the relay ride';
  exception when others then
    assert sqlerrm = 'car_not_at_leg_place', 'R5Q2: expected car_not_at_leg_place, got ' || sqlerrm;
  end;
  perform set_config('app.place_only_leg', '', true);
  delete from public.requests where id = q;
  update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = manager, cancel_reason = 'test' where id = r0;

  ---------------------------------------------------------------- R5B8
  -- three shared cars; three other requests overlap the wait -> "needed elsewhere"
  for k in 1..3 loop
    insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
        depart_at, return_at, trip_shape, status)
      values (dept, w, m2, manager, dest, typ, t0 + interval '12 hours', t0 + interval '14 hours', 'round_trip', 'waitlisted');
  end loop;
  -- a short wait: out 12:15-12:45, back 13:15-13:45
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id,
      trip_type, trip_shape, needs_car_at_destination, depart_at, return_at, status)
    values (dept, w, m1, manager, home, dest, typ, 'drop_off', 'round_trip', false, t0 + interval '12 hours 15 minutes', t0 + interval '13 hours 45 minutes', 'waitlisted') returning id into q;
  assert public.car_wait_needed_elsewhere(dept, w, t0 + interval '12 hours 45 minutes', t0 + interval '13 hours 15 minutes', array[q]), 'setup: the wait is contested';
  insert into public.rides(department_id, week_start, car_id, driver_id, needs_driver, origin_id, destination_id, created_by,
      starts_at, ends_at, status, pin_reason)
    values (dept, w, carA, null, true, home, home, manager, t0 + interval '12 hours 15 minutes', t0 + interval '12 hours 45 minutes', 'draft', 'MISSING_DRIVER') returning id into r;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r, q, 'passenger', 'out', 'chauffeur');
  insert into public.rides(department_id, week_start, car_id, driver_id, needs_driver, origin_id, destination_id, created_by,
      starts_at, ends_at, status, pin_reason)
    values (dept, w, carA, null, true, home, home, manager, t0 + interval '13 hours 15 minutes', t0 + interval '13 hours 45 minutes', 'draft', 'MISSING_DRIVER') returning id into r0;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r0, q, 'passenger', 'return', 'chauffeur');
  perform public.connect_drop_off_legs(carA, w);
  assert (select count(*) = 2 and bool_and(rr.car_mode = 'relay' and rr.role = 'driver')
          from public.ride_requests rr where rr.request_id = q), 'R5B8: a short wait is connected despite the demand';
  assert (select count(*) = 1 from public.rides rd where rd.id in (r, r0) and rd.origin_id = dest and rd.destination_id = home), 'R5B8: the return leg runs from X home';

  -- a long wait that is needed elsewhere stays two legs
  update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = manager, cancel_reason = 'test' where id in (r, r0);
  delete from public.ride_requests where request_id = q;
  update public.requests set depart_at = t0 + interval '9 hours', return_at = t0 + interval '15 hours' where id = q;
  update public.requests set depart_at = t0 + interval '10 hours', return_at = t0 + interval '14 hours' where department_id = dept and week_start = w and id <> q and status = 'waitlisted';
  insert into public.rides(department_id, week_start, car_id, driver_id, needs_driver, origin_id, destination_id, created_by,
      starts_at, ends_at, status, pin_reason)
    values (dept, w, carA, null, true, home, home, manager, t0 + interval '9 hours', t0 + interval '9 hours 45 minutes', 'draft', 'MISSING_DRIVER') returning id into r;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r, q, 'passenger', 'out', 'chauffeur');
  insert into public.rides(department_id, week_start, car_id, driver_id, needs_driver, origin_id, destination_id, created_by,
      starts_at, ends_at, status, pin_reason)
    values (dept, w, carA, null, true, home, home, manager, t0 + interval '14 hours 15 minutes', t0 + interval '15 hours', 'draft', 'MISSING_DRIVER') returning id into r0;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r0, q, 'passenger', 'return', 'chauffeur');
  perform public.connect_drop_off_legs(carA, w);
  assert (select bool_and(rr.car_mode = 'chauffeur') from public.ride_requests rr where rr.request_id = q), 'R5B8: a long contested wait stays two chauffeur legs';
end $$;
rollback;
