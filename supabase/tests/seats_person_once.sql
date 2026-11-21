-- CM1 phase 1 (REQ item 260 a): one person counts once in a ride's seats. The same requester on two requests of a
-- ride, a requester who is a companion on another request, the same child on two requests - each takes one seat;
-- unrelated people still add up and are refused. `ride_seats_verdict` (the merge probe) and `assert_ride_seats_fit`
-- (every write) agree. Transactional (rolled back). Seeded נבו department; car …0040 seats 5 adults; home …0010,
-- חיפה …0011.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car1 uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 1470;
  d0 timestamptz;
  qA uuid; qB uuid; qC uuid; qD uuid; qE uuid; qF uuid; rA uuid; kid uuid; v_failed boolean;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  d0 := ((w + 1) + time '08:00') at time zone 'Asia/Jerusalem';

  -- m1 drives home -> חיפה and back with three unnamed adults: 4 of 5 seats
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_shape, status, adults)
    values (dept, w, m1, manager, home, haifa, typ, d0, d0 + interval '6 hours', 'round_trip', 'assigned', 4) returning id into qA;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, car1, d0, d0 + interval '6 hours', home, home, m1, 'draft', manager) returning id into rA;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qA, 'driver', 'both', 'keep');

  -- m1's second request, m1 + one more: 6 by the sum, 5 people
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_shape, status, adults)
    values (dept, w, m1, manager, home, haifa, typ, d0, d0 + interval '6 hours', 'round_trip', 'submitted', 2) returning id into qB;

  -----------------------------------------------------------------------
  -- 1) The same requester on two requests counts once: the probe and the write both fit.
  -----------------------------------------------------------------------
  assert public.ride_seats_verdict(rA, jsonb_build_array(jsonb_build_object('request_id', qB, 'leg', 'both'))) is null,
    'TEST 1 FAILED: the probe counts m1 twice';
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qB, 'passenger', 'both', 'passenger');
  perform public.assert_ride_seats_fit(rA);
  assert (public._ride_seat_dupes(rA, 'out') ->> 'adults')::int = 1, 'TEST 1 FAILED: one duplicate seat';

  -----------------------------------------------------------------------
  -- 2) Someone else is a seat of their own: m2 alone on a full ride is refused by the probe and by the write.
  -----------------------------------------------------------------------
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_shape, status, adults)
    values (dept, w, m2, manager, home, haifa, typ, d0, d0 + interval '6 hours', 'round_trip', 'submitted', 1) returning id into qD;
  assert public.ride_seats_verdict(rA, jsonb_build_array(jsonb_build_object('request_id', qD, 'leg', 'both'))) = 'seat_config_violation',
    'TEST 2 FAILED: the probe seats a sixth person';
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (rA, qD, 'passenger', 'both', 'passenger');
  v_failed := false;
  begin
    perform public.assert_ride_seats_fit(rA);
  exception when others then v_failed := sqlerrm = 'seat_config_violation';
  end;
  assert v_failed, 'TEST 2 FAILED: the write seats a sixth person';
  delete from public.ride_requests where ride_id = rA and request_id = qD;
  delete from public.ride_requests where ride_id = rA and request_id = qB;

  -----------------------------------------------------------------------
  -- 3) A requester who is a companion on another request: m2 files for m2 + m1 (companion) - m1 is already driving.
  -----------------------------------------------------------------------
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_shape, status, adults)
    values (dept, w, m2, manager, home, haifa, typ, d0, d0 + interval '6 hours', 'round_trip', 'submitted', 2) returning id into qC;
  insert into public.request_companions(request_id, profile_id) values (qC, m1);
  assert public.ride_seats_verdict(rA, jsonb_build_array(jsonb_build_object('request_id', qC, 'leg', 'both'))) is null,
    'TEST 3 FAILED: the companion counted twice';
  -- ... and only on the leg both requests ride: m2's request only one way still fits that way, the other way is 4
  assert (public._ride_seat_dupes(rA, 'return', jsonb_build_array(jsonb_build_object('request_id', qC, 'leg', 'out'))) ->> 'adults')::int = 0,
    'TEST 3 FAILED: a duplicate on a leg the guest does not ride';

  -----------------------------------------------------------------------
  -- 4) The same child on two requests takes one child seat.
  -----------------------------------------------------------------------
  insert into public.children(department_id, full_name, birth_year) values (dept, 'ילד בדיקה', extract(year from d0 at time zone 'Asia/Jerusalem')::int - 4) returning id into kid;
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_shape, status, adults, child_seats)
    values (dept, w, m2, manager, home, haifa, typ, d0, d0 + interval '6 hours', 'round_trip', 'submitted', 1, 1) returning id into qE;
  insert into public.request_children(request_id, child_id) values (qE, kid);
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id, depart_at, return_at,
                              trip_shape, status, adults, child_seats)
    values (dept, w, m1, manager, home, haifa, typ, d0, d0 + interval '6 hours', 'round_trip', 'submitted', 1, 1) returning id into qF;
  insert into public.request_children(request_id, child_id) values (qF, kid);
  assert (public._ride_seat_dupes(rA, 'out', jsonb_build_array(jsonb_build_object('request_id', qE, 'leg', 'both'),
            jsonb_build_object('request_id', qF, 'leg', 'both'))) ->> 'childSeats')::int = 1,
    'TEST 4 FAILED: the child counted twice';
  -- nobody counted twice: the helper leaves the plain sum standing
  assert not public._seats_fit_once(car1, rA, 'out', 9, 0, 0, 0), 'TEST 4 FAILED: no duplicates must not pass a refused sum';

  raise notice 'seats_person_once: all tests passed';
end $$;

rollback;
