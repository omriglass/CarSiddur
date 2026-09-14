-- car_mileage_totals() RPC (F5, docs/TODO.md "Solver: spread rides across cars to
-- balance mileage"; REQUIREMENTS §13.84; DATA_MODEL.md §7.7/RPC list). Transactional:
-- every fixture row is rolled back at the end, safe to run repeatedly against a seeded
-- local database. Uses the seeded נבו department (…0001, home …0010), admin …0101,
-- sadran …0102, members …0103/…0104, shared cars …0040/…0041/…0042 (temporary car
-- …0043 must never appear in the result), destinations חיפה …0011 (distance_km 12.0)
-- and בנימינה …0012 (distance_km 6.5), on a far-past week so nothing collides with the
-- demo data or the other suites.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  other_dept uuid;
  admin_id uuid := '00000000-0000-0000-0000-000000000101';
  sadran_id uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  member2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  haifa uuid := '00000000-0000-0000-0000-000000000011';       -- distance_km 12.0
  binyamina uuid := '00000000-0000-0000-0000-000000000012';   -- distance_km 6.5
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  car_a uuid := '00000000-0000-0000-0000-000000000040';
  car_b uuid := '00000000-0000-0000-0000-000000000041';
  car_c uuid := '00000000-0000-0000-0000-000000000042';
  car_priv uuid := '00000000-0000-0000-0000-000000000043';   -- temporary, must be excluded
  w date := public.current_week_start() - 903;   -- far-past Sunday (multiple of 7) = p_week_start argument
  w1 date := w - 7;    -- 1 week back, inside a 4-week window
  w3 date := w - 21;   -- 3 weeks back, inside
  w4 date := w - 28;   -- exactly 4 weeks back -- boundary, must still be included
  w5 date := w - 35;   -- 5 weeks back -- outside the 4-week window, must be excluded
  km_a numeric; km_b numeric; km_c numeric;
  row_count int;
  rls_ok boolean;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
  values
    (dept, w, 'solving', now() - interval '2 days', now() - interval '1 day', now() + interval '1 day'),
    (dept, w1, 'archived', now() - interval '9 days', now() - interval '8 days', now() - interval '7 days'),
    (dept, w3, 'archived', now() - interval '23 days', now() - interval '22 days', now() - interval '21 days'),
    (dept, w4, 'archived', now() - interval '30 days', now() - interval '29 days', now() - interval '28 days'),
    (dept, w5, 'archived', now() - interval '37 days', now() - interval '36 days', now() - interval '35 days');

  -- (1) car_a, week w1, round trip to haifa (origin=destination=home) -> 2 x 12.0 = 24.
  insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id,
    ride_type_id, trip_shape, depart_at, return_at, adults, submitted_at, status)
  values ('50000000-0000-0000-0000-000000000001', dept, w1, member1, member1, haifa, ride_type,
    'round_trip', (w1+1 + time '08:00') at time zone 'Asia/Jerusalem', (w1+1 + time '10:00') at time zone 'Asia/Jerusalem',
    1, now(), 'assigned');
  insert into public.rides (id, department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by)
  values ('60000000-0000-0000-0000-000000000001', dept, w1, car_a,
    (w1+1 + time '08:00') at time zone 'Asia/Jerusalem', (w1+1 + time '10:00') at time zone 'Asia/Jerusalem',
    home, home, member1, 'confirmed', sadran_id);
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
  values ('60000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'driver', 'both', 'keep');

  -- (2) car_b, week w3, round trip to binyamina -> 2 x 6.5 = 13.
  insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id,
    ride_type_id, trip_shape, depart_at, return_at, adults, submitted_at, status)
  values ('50000000-0000-0000-0000-000000000002', dept, w3, member2, member2, binyamina, ride_type,
    'round_trip', (w3+1 + time '08:00') at time zone 'Asia/Jerusalem', (w3+1 + time '10:00') at time zone 'Asia/Jerusalem',
    1, now(), 'assigned');
  insert into public.rides (id, department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by)
  values ('60000000-0000-0000-0000-000000000002', dept, w3, car_b,
    (w3+1 + time '08:00') at time zone 'Asia/Jerusalem', (w3+1 + time '10:00') at time zone 'Asia/Jerusalem',
    home, home, member2, 'confirmed', sadran_id);
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
  values ('60000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000002', 'driver', 'both', 'keep');

  -- (3) car_a, week w5 (5 weeks back -- OUTSIDE the 4-week window), round trip to haifa.
  -- Must be excluded: if it leaked in, car_a would read 24+24=48 instead of 24 (+ item 6 below).
  insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id,
    ride_type_id, trip_shape, depart_at, return_at, adults, submitted_at, status)
  values ('50000000-0000-0000-0000-000000000003', dept, w5, member1, member1, haifa, ride_type,
    'round_trip', (w5+1 + time '08:00') at time zone 'Asia/Jerusalem', (w5+1 + time '10:00') at time zone 'Asia/Jerusalem',
    1, now(), 'assigned');
  insert into public.rides (id, department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by)
  values ('60000000-0000-0000-0000-000000000003', dept, w5, car_a,
    (w5+1 + time '08:00') at time zone 'Asia/Jerusalem', (w5+1 + time '10:00') at time zone 'Asia/Jerusalem',
    home, home, member1, 'confirmed', sadran_id);
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
  values ('60000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-000000000003', 'driver', 'both', 'keep');

  -- (4) car_b, relay pair to haifa in week w1: out-leg + return-leg, two separate ride rows,
  -- 1 x 12.0 each = 24 total (same total a round trip to the same place would give).
  insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id,
    ride_type_id, trip_shape, depart_at, one_way_car_mode, needs_car_at_destination, adults, submitted_at, status)
  values ('50000000-0000-0000-0000-000000000004', dept, w1, member1, member1, haifa, ride_type,
    'one_way_to', (w1+2 + time '08:00') at time zone 'Asia/Jerusalem', 'relay', false, 1, now(), 'assigned');
  insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id,
    ride_type_id, trip_shape, return_at, one_way_car_mode, needs_car_at_destination, adults, submitted_at, status)
  values ('50000000-0000-0000-0000-000000000005', dept, w1, member2, member2, haifa, ride_type,
    'one_way_from', (w1+2 + time '18:00') at time zone 'Asia/Jerusalem', 'relay', false, 1, now(), 'assigned');
  insert into public.rides (id, department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by)
  values
    ('60000000-0000-0000-0000-000000000004', dept, w1, car_b,
      (w1+2 + time '08:00') at time zone 'Asia/Jerusalem', (w1+2 + time '09:00') at time zone 'Asia/Jerusalem',
      home, haifa, member1, 'confirmed', sadran_id),
    ('60000000-0000-0000-0000-000000000005', dept, w1, car_b,
      (w1+2 + time '18:00') at time zone 'Asia/Jerusalem', (w1+2 + time '19:00') at time zone 'Asia/Jerusalem',
      haifa, home, member2, 'confirmed', sadran_id);
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
  values
    ('60000000-0000-0000-0000-000000000004', '50000000-0000-0000-0000-000000000004', 'driver', 'out', 'relay'),
    ('60000000-0000-0000-0000-000000000005', '50000000-0000-0000-0000-000000000005', 'driver', 'return', 'relay');

  -- (5) car_c, week w4 (exactly the 4-week boundary -- must be INCLUDED), round trip to
  -- binyamina -> 13.
  insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id,
    ride_type_id, trip_shape, depart_at, return_at, adults, submitted_at, status)
  values ('50000000-0000-0000-0000-000000000006', dept, w4, member1, member1, binyamina, ride_type,
    'round_trip', (w4+1 + time '08:00') at time zone 'Asia/Jerusalem', (w4+1 + time '10:00') at time zone 'Asia/Jerusalem',
    1, now(), 'assigned');
  insert into public.rides (id, department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by)
  values ('60000000-0000-0000-0000-000000000006', dept, w4, car_c,
    (w4+1 + time '08:00') at time zone 'Asia/Jerusalem', (w4+1 + time '10:00') at time zone 'Asia/Jerusalem',
    home, home, member1, 'confirmed', sadran_id);
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
  values ('60000000-0000-0000-0000-000000000006', '50000000-0000-0000-0000-000000000006', 'driver', 'both', 'keep');

  -- (6) car_a, CURRENT week w (= p_week_start), status 'confirmed' -> counts (+24, on top
  -- of item 1's 24 from w1 -> car_a totals 48).
  insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id,
    ride_type_id, trip_shape, depart_at, return_at, adults, submitted_at, status)
  values ('50000000-0000-0000-0000-000000000007', dept, w, member1, member1, haifa, ride_type,
    'round_trip', (w+1 + time '08:00') at time zone 'Asia/Jerusalem', (w+1 + time '10:00') at time zone 'Asia/Jerusalem',
    1, now(), 'assigned');
  insert into public.rides (id, department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by)
  values ('60000000-0000-0000-0000-000000000007', dept, w, car_a,
    (w+1 + time '08:00') at time zone 'Asia/Jerusalem', (w+1 + time '10:00') at time zone 'Asia/Jerusalem',
    home, home, member1, 'confirmed', sadran_id);
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
  values ('60000000-0000-0000-0000-000000000007', '50000000-0000-0000-0000-000000000007', 'driver', 'both', 'keep');

  -- (7) car_b, CURRENT week w, status 'draft' -- a not-yet-applied solver draft for the
  -- very week being solved must NOT count (it would double-count once the Sadran applies
  -- it and it becomes 'confirmed').
  insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id,
    ride_type_id, trip_shape, depart_at, return_at, adults, submitted_at, status)
  values ('50000000-0000-0000-0000-000000000008', dept, w, member2, member2, haifa, ride_type,
    'round_trip', (w+2 + time '08:00') at time zone 'Asia/Jerusalem', (w+2 + time '10:00') at time zone 'Asia/Jerusalem',
    1, now(), 'assigned');
  insert into public.rides (id, department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by)
  values ('60000000-0000-0000-0000-000000000008', dept, w, car_b,
    (w+2 + time '08:00') at time zone 'Asia/Jerusalem', (w+2 + time '10:00') at time zone 'Asia/Jerusalem',
    home, home, member2, 'draft', sadran_id);
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
  values ('60000000-0000-0000-0000-000000000008', '50000000-0000-0000-0000-000000000008', 'driver', 'both', 'keep');

  -- (8) car_a, week w1, status 'cancelled' -- must NOT count.
  insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id,
    ride_type_id, trip_shape, depart_at, return_at, adults, submitted_at, status)
  values ('50000000-0000-0000-0000-000000000009', dept, w1, member1, member1, haifa, ride_type,
    'round_trip', (w1+3 + time '08:00') at time zone 'Asia/Jerusalem', (w1+3 + time '10:00') at time zone 'Asia/Jerusalem',
    1, now(), 'cancelled');
  insert into public.rides (id, department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by, cancelled_at, cancelled_by, cancel_reason)
  values ('60000000-0000-0000-0000-000000000009', dept, w1, car_a,
    (w1+3 + time '08:00') at time zone 'Asia/Jerusalem', (w1+3 + time '10:00') at time zone 'Asia/Jerusalem',
    home, home, member1, 'cancelled', sadran_id, now(), sadran_id, 'test');
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
  values ('60000000-0000-0000-0000-000000000009', '50000000-0000-0000-0000-000000000009', 'driver', 'both', 'keep');

  -- (9) car_c, week w1, round trip with a FREE-TEXT destination (destination_id null) --
  -- distance is unknown, must contribute 0.
  insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_text,
    ride_type_id, trip_shape, depart_at, return_at, adults, submitted_at, status)
  values ('50000000-0000-0000-0000-000000000010', dept, w1, member1, member1, 'מקום כלשהו', ride_type,
    'round_trip', (w1+4 + time '08:00') at time zone 'Asia/Jerusalem', (w1+4 + time '10:00') at time zone 'Asia/Jerusalem',
    1, now(), 'assigned');
  insert into public.rides (id, department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, created_by)
  values ('60000000-0000-0000-0000-000000000010', dept, w1, car_c,
    (w1+4 + time '08:00') at time zone 'Asia/Jerusalem', (w1+4 + time '10:00') at time zone 'Asia/Jerusalem',
    home, home, member1, 'confirmed', sadran_id);
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
  values ('60000000-0000-0000-0000-000000000010', '50000000-0000-0000-0000-000000000010', 'driver', 'both', 'keep');

  -- Expected totals: car_a = 24 (w1 haifa round trip) + 24 (w current confirmed) = 48
  -- (w5's 24 excluded -- outside window; the cancelled w1 ride excluded).
  -- car_b = 13 (w3 binyamina round trip) + 24 (w1 haifa relay pair, 12+12) = 37
  -- (the current-week draft ride excluded).
  -- car_c = 13 (w4 boundary round trip) + 0 (w1 free-text round trip) = 13.
  -- car_priv (temporary) must not appear at all.

  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  select km into km_a from public.car_mileage_totals(dept, w, 4) where car_id = car_a;
  select km into km_b from public.car_mileage_totals(dept, w, 4) where car_id = car_b;
  select km into km_c from public.car_mileage_totals(dept, w, 4) where car_id = car_c;
  select count(*) into row_count from public.car_mileage_totals(dept, w, 4) where car_id = car_priv;

  assert km_a = 48, format('(1) car_a mileage mismatch: got %s, expected 48', km_a);
  assert km_b = 37, format('(2) car_b mileage mismatch: got %s, expected 37', km_b);
  assert km_c = 13, format('(3) car_c mileage mismatch: got %s, expected 13', km_c);
  assert row_count = 0, '(4) the temporary car must never appear in car_mileage_totals (type <> shared)';

  -- Any approved department member may call it (unlike fairness_stats, which is
  -- Sadran/admin-only) -- member1 above already succeeded as a plain member.
  execute 'reset role';

  -- A member of a DIFFERENT department must be refused (member_of() fails for that dept).
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select id into other_dept from public.create_department('Mileage isolation test', 'mileage-isolation-test');
  execute 'reset role';

  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    perform 1 from public.car_mileage_totals(other_dept, w, 4) limit 1;
    rls_ok := false;
  exception when others then
    rls_ok := true;
  end;
  execute 'reset role';
  assert rls_ok, '(5) a member of this department must not read another department''s mileage totals';
end;
$$;

reset role;
rollback;
