-- department_stats() RPC (REQ §13.78, DATA_MODEL §7.6).
-- Transactional: every fixture row is rolled back at the end, so this is safe to run
-- repeatedly against a seeded local database. Uses the seeded נבו department (…0001,
-- home …0010), admin …0101, Sadran …0102, members …0103/…0104, shared cars
-- …0040/…0041/…0042, temporary car …0043 (owner …0104), destination חיפה …0011,
-- ride type …0021, on a far-future week so nothing collides with the demo data or the
-- other suites.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  admin_id uuid := '00000000-0000-0000-0000-000000000101';
  sadran_id uuid := '00000000-0000-0000-0000-000000000102';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  member2 uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  car_a uuid := '00000000-0000-0000-0000-000000000040';
  car_b uuid := '00000000-0000-0000-0000-000000000041';
  car_c uuid := '00000000-0000-0000-0000-000000000042';
  car_priv uuid := '00000000-0000-0000-0000-000000000043';
  w date := public.current_week_start() + 700;   -- far-future Sunday
  w2 date := w + 7;
  day1 date := w + 1;   -- Monday
  day2 date := w + 2;   -- Tuesday
  day3 date := w + 3;   -- Wednesday
  day4 date := w + 4;   -- Thursday
  p_from date := w;     -- Sunday, dow 0
  p_to date := w + 13;  -- 14 days -> every weekday occurs exactly twice
  policy_id uuid; policy_version_id uuid;
  shared_car_count int;
  result jsonb; wd jsonb;
  mon jsonb; tue jsonb; wed jsonb;
  other_dept uuid;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '2 days', now() - interval '1 day', now() + interval '1 day');
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w2, 'solving', now() - interval '9 days', now() - interval '8 days', now() - interval '7 days');

  -- Rides ------------------------------------------------------------------
  -- day1 06:00-08:00 window overlap = 2h (05:00-08:00 clipped to [06:00,22:00)).
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id,
    destination_id, driver_id, status, created_by)
  values (dept, w, car_a, (day1 + time '05:00') at time zone 'Asia/Jerusalem',
    (day1 + time '08:00') at time zone 'Asia/Jerusalem', home, home, sadran_id, 'confirmed', sadran_id);
  -- day1 21:00-23:30 window overlap = 1h (21:00-22:00).
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id,
    destination_id, driver_id, status, created_by)
  values (dept, w, car_b, (day1 + time '21:00') at time zone 'Asia/Jerusalem',
    (day1 + time '23:30') at time zone 'Asia/Jerusalem', home, home, sadran_id, 'confirmed', sadran_id);
  -- day2 20:00-23:00: window overlap = 2h (20:00-22:00).
  -- (Brief asked for a ride spanning midnight 21:00->01:00 counting 1h; that is no longer
  -- constructible under the current schema -- `assert_same_day_window()`
  -- (`20260907102000_coordinator_planning_and_same_day_rides.sql`) rejects any ride whose
  -- start and end fall on different Jerusalem calendar days with `ride_must_end_same_day`,
  -- so every ride, by construction, can only ever touch the one or two days the [06:00,22:00)
  -- window computation already handles; a same-day late-evening ride exercises the same
  -- clipping logic without the impossible cross-midnight case. Reported as a correction.)
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id,
    destination_id, driver_id, status, created_by)
  values (dept, w, car_c, (day2 + time '20:00') at time zone 'Asia/Jerusalem',
    (day2 + time '23:00') at time zone 'Asia/Jerusalem', home, home, sadran_id, 'confirmed', sadran_id);
  -- Cancelled ride on day4: must be entirely ignored.
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id,
    destination_id, driver_id, status, cancelled_at, cancelled_by, cancel_reason, created_by)
  values (dept, w, car_a, (day4 + time '10:00') at time zone 'Asia/Jerusalem',
    (day4 + time '12:00') at time zone 'Asia/Jerusalem', home, home, sadran_id, 'cancelled',
    now(), sadran_id, 'test cancel', sadran_id);
  -- Private (temporary) car ride on day1: must be entirely ignored (not a shared car).
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id,
    destination_id, driver_id, status, created_by)
  values (dept, w, car_priv, (day1 + time '09:00') at time zone 'Asia/Jerusalem',
    (day1 + time '11:00') at time zone 'Asia/Jerusalem', home, home, member2, 'confirmed', member2);

  -- Requests -----------------------------------------------------------------
  -- granted (assigned/merged) = 2, unmet (denied/external/waitlisted) = 3, cancelled = 1,
  -- submitted (counts toward total only) = 1, plus a draft and a withdrawn that must be
  -- excluded entirely. total = 7, unmetRate = 3/7.
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id,
    ride_type_id, trip_shape, depart_at, return_at, adults, submitted_at, status)
  values
    (dept, w, member1, member1, dest, ride_type, 'round_trip',
      (day1 + time '08:00') at time zone 'Asia/Jerusalem', (day1 + time '10:00') at time zone 'Asia/Jerusalem',
      1, now(), 'assigned'),
    (dept, w, member2, member2, dest, ride_type, 'round_trip',
      (day1 + time '08:00') at time zone 'Asia/Jerusalem', (day1 + time '10:00') at time zone 'Asia/Jerusalem',
      1, now(), 'merged'),
    (dept, w, member1, member1, dest, ride_type, 'round_trip',
      (day2 + time '08:00') at time zone 'Asia/Jerusalem', (day2 + time '10:00') at time zone 'Asia/Jerusalem',
      1, now(), 'denied'),
    (dept, w, member2, member2, dest, ride_type, 'round_trip',
      (day2 + time '08:00') at time zone 'Asia/Jerusalem', (day2 + time '10:00') at time zone 'Asia/Jerusalem',
      1, now(), 'external'),
    (dept, w, member1, member1, dest, ride_type, 'round_trip',
      (day3 + time '08:00') at time zone 'Asia/Jerusalem', (day3 + time '10:00') at time zone 'Asia/Jerusalem',
      1, now(), 'waitlisted'),
    (dept, w, member2, member2, dest, ride_type, 'round_trip',
      (day3 + time '08:00') at time zone 'Asia/Jerusalem', (day3 + time '10:00') at time zone 'Asia/Jerusalem',
      1, now(), 'cancelled'),
    (dept, w, member1, member1, dest, ride_type, 'round_trip',
      (day1 + time '08:00') at time zone 'Asia/Jerusalem', (day1 + time '10:00') at time zone 'Asia/Jerusalem',
      1, now(), 'draft'),
    (dept, w, member2, member2, dest, ride_type, 'round_trip',
      (day1 + time '08:00') at time zone 'Asia/Jerusalem', (day1 + time '10:00') at time zone 'Asia/Jerusalem',
      1, now(), 'withdrawn'),
    (dept, w, member1, member1, dest, ride_type, 'round_trip',
      (day4 + time '08:00') at time zone 'Asia/Jerusalem', (day4 + time '10:00') at time zone 'Asia/Jerusalem',
      1, now(), 'submitted');

  -- Policy score ---------------------------------------------------------------
  select id, current_version_id into policy_id, policy_version_id
  from public.policies where department_id = dept and is_active limit 1;
  assert policy_id is not null, 'seeded department has no active policy to score against';

  -- Week w: two versions; only the latest (0.6) must count.
  insert into public.siddur_versions (department_id, week_start, snapshot, published_by, published_at)
  values (dept, w, jsonb_build_object(
      'policy_version_id', policy_version_id,
      'policy_scores', jsonb_build_array(jsonb_build_object(
        'policy_id', policy_id, 'policy_version_id', policy_version_id, 'alignment_ratio', 0.8))),
    sadran_id, (day1 + time '09:00') at time zone 'Asia/Jerusalem');
  insert into public.siddur_versions (department_id, week_start, snapshot, published_by, published_at)
  values (dept, w, jsonb_build_object(
      'policy_version_id', policy_version_id,
      'policy_scores', jsonb_build_array(jsonb_build_object(
        'policy_id', policy_id, 'policy_version_id', policy_version_id, 'alignment_ratio', 0.6))),
    sadran_id, (day2 + time '09:00') at time zone 'Asia/Jerusalem');
  -- Week w2: alignment_ratio 0 -> ignored entirely.
  insert into public.siddur_versions (department_id, week_start, snapshot, published_by, published_at)
  values (dept, w2, jsonb_build_object(
      'policy_version_id', policy_version_id,
      'policy_scores', jsonb_build_array(jsonb_build_object(
        'policy_id', policy_id, 'policy_version_id', policy_version_id, 'alignment_ratio', 0))),
    sadran_id, (w2 + 3 + time '09:00') at time zone 'Asia/Jerusalem');

  select count(*) into shared_car_count from public.cars
  where department_id = dept and type = 'shared' and status = 'active';
  assert shared_car_count = 3, 'seeded department no longer has exactly 3 active shared cars; adjust fixture';

  -- (a) admin reads the stats.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  result := public.department_stats(dept, p_from, p_to);

  assert (result ->> 'from') = p_from::text, '(a) from mismatch';
  assert (result ->> 'to') = p_to::text, '(a) to mismatch';
  assert (result ->> 'days')::int = 14, '(a) days mismatch';
  assert (result ->> 'sharedCars')::int = 3, '(a) sharedCars mismatch';
  assert (result -> 'utilization' ->> 'activeHours')::numeric = 5.0, '(a) activeHours: expected 2+1+2=5h, cancelled/private/out-of-window excluded';
  assert (result -> 'utilization' ->> 'capacityHours')::numeric = 3 * 14 * 16, '(a) capacityHours mismatch';
  assert (result -> 'utilization' ->> 'rate')::numeric = round(5.0 / (3*14*16), 4), '(a) utilization rate mismatch';

  assert (result -> 'requests' ->> 'total')::int = 7, '(a) requests.total mismatch';
  assert (result -> 'requests' ->> 'granted')::int = 2, '(a) requests.granted mismatch';
  assert (result -> 'requests' ->> 'unmet')::int = 3, '(a) requests.unmet mismatch';
  assert (result -> 'requests' ->> 'cancelled')::int = 1, '(a) requests.cancelled mismatch';
  assert (result -> 'requests' ->> 'unmetRate')::numeric = round(3.0/7, 4), '(a) unmetRate mismatch';

  assert (result ->> 'rides')::int = 3, '(a) rides mismatch: A, B and C start in range; cancelled/private do not count';

  select jsonb_array_length(result -> 'byWeekday') into shared_car_count;
  assert shared_car_count = 7, '(a) byWeekday must always list all 7 weekdays';

  select item into mon from jsonb_array_elements(result -> 'byWeekday') item where (item ->> 'dow')::int = extract(dow from day1)::int;
  select item into tue from jsonb_array_elements(result -> 'byWeekday') item where (item ->> 'dow')::int = extract(dow from day2)::int;
  select item into wed from jsonb_array_elements(result -> 'byWeekday') item where (item ->> 'dow')::int = extract(dow from day3)::int;

  assert (mon ->> 'occurrences')::int = 2, '(a) Monday occurrences over 14 days must be 2';
  assert (mon ->> 'avgActiveHours')::numeric = 1.5, '(a) Monday avgActiveHours: (2h+1h)/2 occurrences';
  assert (mon ->> 'avgRides')::numeric = 1.0, '(a) Monday avgRides: 2 rides start on the one Monday with data / 2 occurrences';
  assert (mon ->> 'utilizationRate')::numeric = round(1.5/(3*16), 4), '(a) Monday utilizationRate mismatch';

  assert (tue ->> 'occurrences')::int = 2, '(a) Tuesday occurrences must be 2';
  assert (tue ->> 'avgActiveHours')::numeric = 1.0, '(a) Tuesday avgActiveHours: 2h / 2 occurrences';
  assert (tue ->> 'avgRides')::numeric = 0.5, '(a) Tuesday avgRides: 1 ride starts on Tuesday / 2 occurrences';

  assert (wed ->> 'avgActiveHours')::numeric = 0, '(a) Wednesday avgActiveHours: no ride touches that day at all';

  assert (result -> 'policyScore' ->> 'average')::numeric = 0.6, '(a) policyScore.average must use only the latest version per week and ignore the zero-scored week';
  assert (result -> 'policyScore' ->> 'weeks')::int = 1, '(a) policyScore.weeks must count only the one non-zero week';

  -- (b) Sadran of the department reads the same stats.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran_id, 'role', 'authenticated')::text, true);
  result := public.department_stats(dept, p_from, p_to);
  assert (result ->> 'rides')::int = 3, '(b) sadran must see the same figures as admin';

  -- (c) A plain member of the department is refused.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  begin
    perform public.department_stats(dept, p_from, p_to);
    raise exception '(c) FAILED: plain member must not read department_stats';
  exception when raise_exception then if sqlerrm <> 'not_authorized' then raise; end if; end;

  -- (d) Two departments: a Sadran of a different department is refused for this one
  -- (isolation), even though they are a legitimate Sadran elsewhere.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  select id into other_dept from public.create_department('Stats isolation test', 'stats-isolation-test');
  insert into public.department_members (department_id, profile_id, role, added_by)
  values (other_dept, member1, 'sadran', admin_id);
  insert into public.sadran_assignments (department_id, profile_id, week_start)
  values (other_dept, member1, null)
  on conflict do nothing;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  assert public.is_sadran_any(other_dept), '(d) fixture setup: member1 must be a sadran of the other department';
  begin
    perform public.department_stats(dept, p_from, p_to);
    raise exception '(d) FAILED: a sadran of a different department must not read this department''s stats';
  exception when raise_exception then if sqlerrm <> 'not_authorized' then raise; end if; end;
  -- ... but does read their own department's (empty) stats fine.
  result := public.department_stats(other_dept, p_from, p_to);
  assert (result ->> 'sharedCars')::int = 0, '(d) the other department has no cars of its own';

  -- (e) invalid_range: to before from.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  begin
    perform public.department_stats(dept, p_to, p_from);
    raise exception '(e) FAILED: to < from must be refused';
  exception when raise_exception then if sqlerrm <> 'invalid_range' then raise; end if; end;

  -- (e) invalid_range: span over 400 days.
  begin
    perform public.department_stats(dept, p_from, p_from + 401);
    raise exception '(e) FAILED: a 402-day span must be refused';
  exception when raise_exception then if sqlerrm <> 'invalid_range' then raise; end if; end;

  -- A 400-day span (inclusive) is still accepted.
  perform public.department_stats(dept, p_from, p_from + 399);
end $$;

reset role;
rollback;
