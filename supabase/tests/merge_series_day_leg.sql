-- QA run 22 R22B10 (owner 2026-11-22): one day of a multi-day ride drives only some legs. A merge onto a later day's
-- ride has no way out, onto an earlier day's no way back: refused `series_day_leg`; the leg that day drives is fine.
-- Transactional.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  manager uuid := '00000000-0000-0000-0000-000000000102';
  m1 uuid := '00000000-0000-0000-0000-000000000103';
  m2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  carA uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 1533;
  d1 timestamptz; d2 timestamptz; s uuid := gen_random_uuid(); q1 uuid; q2 uuid; qg uuid; r1 uuid; r2 uuid;
begin
  d1 := ((w + 1) + time '08:00') at time zone 'Asia/Jerusalem';
  d2 := ((w + 2) + time '00:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '2 days', now() + interval '1 day', now() + interval '2 days');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::text, true);
  -- m1 away Monday 08:00 to Tuesday 17:45: day 1 drives out only, day 2 back only
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at, trip_shape, status, series_id, series_index, series_count)
    values (dept, w, m1, manager, dest, typ, d1, ((w + 1) + time '23:59') at time zone 'Asia/Jerusalem', 'round_trip', 'assigned', s, 1, 2) returning id into q1;
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at, trip_shape, status, series_id, series_index, series_count)
    values (dept, w, m1, manager, dest, typ, d2, d2 + interval '17 hours 45 minutes', 'round_trip', 'assigned', s, 2, 2) returning id into q2;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, carA, d2, d2 + interval '17 hours 45 minutes', home, home, m1, 'draft', manager) returning id into r2;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r2, q2, 'driver', 'both', 'keep');
  -- m2 wants to come back from the same place on Tuesday (a round trip)
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at, trip_shape, status)
    values (dept, w, m2, manager, dest, typ, d2 + interval '8 hours', d2 + interval '17 hours 45 minutes', 'round_trip', 'submitted') returning id into qg;

  assert public._merge_check(r2, qg, 'out') ->> 'code' = 'series_day_leg', format('TEST 1 FAILED: out %s', public._merge_check(r2, qg, 'out'));
  assert public._merge_check(r2, qg, 'both') ->> 'code' = 'series_day_leg', 'TEST 2 FAILED: both';
  assert coalesce(public._merge_check(r2, qg, 'return') ->> 'code', '') <> 'series_day_leg', 'TEST 3 FAILED: the way back is driven that day';

  -- day 1 has no way back
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, '00000000-0000-0000-0000-000000000042', d1, ((w + 1) + time '23:59') at time zone 'Asia/Jerusalem', home, home, m1, 'draft', manager) returning id into r1;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r1, q1, 'driver', 'both', 'keep');
  assert public._merge_check(r1, qg, 'return') ->> 'code' = 'series_day_leg', 'TEST 4 FAILED: day 1 return';

  raise notice 'merge_series_day_leg.sql: all tests passed';
end $$;

rollback;
