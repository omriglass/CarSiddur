-- QA run 17 (2026-11-01) server fixes. Transactional; rolled back at the end. Seeded נבו department …0001, Sadran …0102,
-- members …0103 / …0104, home …0010, בנימינה …0012, ride type …0021, shared car …0040.
-- R17B1: the person being dropped off cannot take the wheel of their own driverless הקפצה (claim_ride_driver).
-- R17U2: when someone else takes it, its riders are told who drives (driver_assigned_passenger).
-- R17B6: after the driver leaves, a ride left with one chauffeur leg takes that leg's length, not the driver's window.
begin;
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  binyamina uuid := '00000000-0000-0000-0000-000000000012';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  car uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 1379;
  pub uuid; d date; q uuid; q2 uuid; r uuid; v int; n record; v_min int;
begin
  update public.profiles set does_not_drive = false where id in (m1, m2);
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
  values (dept, w, 'solving', now() - interval '9 days', now() - interval '8 days', now() - interval '7 days');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', sadran) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_days = array[w, w+1, w+2, w+3, w+4, w+5, w+6]
  where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);
  d := w + 3;

  -- m1's הקפצה to Binyamina at 08:00 on a driverless chauffeur ride
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id,
    trip_shape, trip_type, one_way_car_mode, depart_at, adults, submitted_at, status)
  values (dept, w, m1, m1, home, binyamina, typ, 'one_way_to', 'drop_off', 'passenger',
    (d + time '08:00') at time zone 'Asia/Jerusalem', 1, now(), 'waitlisted') returning id into q;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id,
    needs_driver, status, flag_reason, created_by)
  values (dept, w, car, (d + time '08:00') at time zone 'Asia/Jerusalem', (d + time '09:00') at time zone 'Asia/Jerusalem',
    home, home, null, true, 'flagged', 'NEEDS_DRIVER', sadran) returning id, version into r, v;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r, q, 'passenger', 'out', 'chauffeur');

  -- TEST 1 (R17B1): m1 rides it, so m1 cannot drive it
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m1, 'role', 'authenticated')::text, true);
  begin
    perform public.claim_ride_driver(r, v);
    raise exception 'TEST 1 FAILED: the rider took the wheel';
  exception when others then
    assert sqlerrm = 'own_dropoff_driver', format('TEST 1 FAILED: expected own_dropoff_driver, got %s', sqlerrm);
  end;
  raise notice 'TEST 1 PASSED: the person being dropped off cannot drive their own הקפצה';

  -- TEST 2 (R17U2): m2 takes it; m1 hears that a driver was found and who
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m2, 'role', 'authenticated')::text, true);
  perform public.claim_ride_driver(r, v);
  assert (select driver_id from public.rides where id = r) = m2, 'TEST 2 FAILED: m2 does not drive';
  select title_he, body_he, data into n from public.notifications
  where recipient_id = m1 and data ->> 'ride_id' = r::text and event = 'outcome_changed' order by created_at desc limit 1;
  assert n.data ->> 'variant' = 'driver_assigned_passenger', format('TEST 2 FAILED: variant %s', n.data);
  assert n.body_he like '%' || (select full_name from public.profiles where id = m2) || '%', format('TEST 2 FAILED: body %s', n.body_he);
  raise notice 'TEST 2 PASSED: the rider is told who drives now';

  -- TEST 3 (R17B6): a ride 08:00–15:00 driven by m2 (round trip) with m1's 08:00 drop-off; m2 cancels it —
  -- the ride left for m1 takes the drop-off's chauffeur length.
  perform set_config('request.jwt.claims', '', true);
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id,
    trip_shape, trip_type, depart_at, return_at, adults, submitted_at, status)
  values (dept, w, m2, m2, home, binyamina, typ, 'round_trip', 'round_trip',
    (d + 1 + time '08:00') at time zone 'Asia/Jerusalem', (d + 1 + time '15:00') at time zone 'Asia/Jerusalem', 1, now(), 'assigned') returning id into q2;
  insert into public.requests(department_id, week_start, requester_id, filed_by, origin_id, destination_id, ride_type_id,
    trip_shape, trip_type, one_way_car_mode, depart_at, adults, submitted_at, status)
  values (dept, w, m1, m1, home, binyamina, typ, 'one_way_to', 'drop_off', 'passenger',
    (d + 1 + time '08:00') at time zone 'Asia/Jerusalem', 1, now(), 'merged') returning id into q;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
  values (dept, w, car, (d + 1 + time '08:00') at time zone 'Asia/Jerusalem', (d + 1 + time '15:00') at time zone 'Asia/Jerusalem',
    home, home, m2, 'confirmed', sadran) returning id, version into r, v;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r, q2, 'driver', 'both', 'keep'), (r, q, 'passenger', 'out', 'chauffeur');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m2, 'role', 'authenticated')::text, true);
  perform public.cancel_ride(r, 'TEST', v);
  v_min := public.chauffeur_ride_minutes(q, 'out');
  assert (select needs_driver from public.rides where id = r), 'TEST 3 FAILED: the ride should wait for a driver';
  assert (select ends_at from public.rides where id = r) = ((d + 1 + time '08:00') at time zone 'Asia/Jerusalem') + make_interval(mins => v_min),
    format('TEST 3 FAILED: expected 08:00 + %s min, got %s', v_min, (select ends_at at time zone 'Asia/Jerusalem' from public.rides where id = r));
  raise notice 'TEST 3 PASSED: the leftover ride takes its drop-off''s length (% min)', v_min;
end $$;
rollback;
