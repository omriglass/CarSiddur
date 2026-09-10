-- department_stats() RPC (REQ §13.78, DATA_MODEL §7.6).
-- Transactional: every fixture row is rolled back at the end, so this is safe to run
-- repeatedly against a seeded local database. Uses the seeded נבו department (…0001,
-- home …0010), admin …0101, Sadran …0102, members …0103/…0104, shared cars
-- …0040/…0041/…0042, temporary car …0043 (owner …0104), destination חיפה …0011,
-- ride type …0021, on a far-past week so nothing collides with the demo data or the
-- other suites (far-past, not far-future, so the range is not entirely clamped away by
-- the "to" is-not-after-today rule added in 20260910098100).
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
  ride_type uuid := '00000000-0000-0000-0000-000000000021';       -- work
  ride_type2 uuid := '00000000-0000-0000-0000-000000000022';      -- childcare
  car_a uuid := '00000000-0000-0000-0000-000000000040';
  car_b uuid := '00000000-0000-0000-0000-000000000041';
  car_c uuid := '00000000-0000-0000-0000-000000000042';
  car_priv uuid := '00000000-0000-0000-0000-000000000043';
  w date := public.current_week_start() - 700;   -- far-past Sunday
  w2 date := w + 7;
  w3 date := w - 7;   -- separate far-past week, for the advance_week_phases archival hook
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
  clamp_dept uuid; clamp_week date;
  future_dept uuid; future_week date;
  today_j date;
  result2 jsonb;
  -- distinctPeople / byRideType fixture: req1 (member1, driver of ride A, 'work'),
  -- req2 (member2, passenger of ride A, 'work'), req3 (member1 again, driver of ride B,
  -- 'childcare') -- exercises "a second request by the same requester counts once". Ride C
  -- stays unlinked (no served requests) -> the null-id 'other' bucket.
  req1_id uuid := '40000000-0000-0000-0000-000000000001';
  req2_id uuid := '40000000-0000-0000-0000-000000000002';
  req3_id uuid := '40000000-0000-0000-0000-000000000003';
  ride_a_id uuid := '40000000-0000-0000-0000-000000000011';
  ride_b_id uuid := '40000000-0000-0000-0000-000000000012';
  ride_c_id uuid := '40000000-0000-0000-0000-000000000013';
  wk_work jsonb; wk_childcare jsonb; wk_other jsonb;
  wk_w jsonb; wk_w2 jsonb;
  rls_count int;
  w3_version_id uuid;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '2 days', now() - interval '1 day', now() + interval '1 day');
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w2, 'solving', now() - interval '9 days', now() - interval '8 days', now() - interval '7 days');

  -- Rides ------------------------------------------------------------------
  -- day1 06:00-08:00 window overlap = 2h (05:00-08:00 clipped to [06:00,22:00)).
  -- driver_id = member1 (not sadran_id) so req1 can be linked as its 'driver' ride_requests
  -- row below (role='driver' => requests.requester_id = rides.driver_id, trigger-enforced).
  insert into public.rides (id, department_id, week_start, car_id, starts_at, ends_at, origin_id,
    destination_id, driver_id, status, created_by)
  values (ride_a_id, dept, w, car_a, (day1 + time '05:00') at time zone 'Asia/Jerusalem',
    (day1 + time '08:00') at time zone 'Asia/Jerusalem', home, home, member1, 'confirmed', sadran_id);
  -- day1 21:00-23:30 window overlap = 1h (21:00-22:00). driver_id = member1 (req3's driver).
  insert into public.rides (id, department_id, week_start, car_id, starts_at, ends_at, origin_id,
    destination_id, driver_id, status, created_by)
  values (ride_b_id, dept, w, car_b, (day1 + time '21:00') at time zone 'Asia/Jerusalem',
    (day1 + time '23:30') at time zone 'Asia/Jerusalem', home, home, member1, 'confirmed', sadran_id);
  -- day2 20:00-23:00: window overlap = 2h (20:00-22:00). Left with no ride_requests at all
  -- (below) -> exercises the null-id 'other' byRideType bucket; driver_id = sadran_id, a
  -- profile with no request of its own, so distinctPeople must still pick it up via
  -- rides.driver_id (the "as driver" half of the union), not just via served requests.
  -- (Brief asked for a ride spanning midnight 21:00->01:00 counting 1h; that is no longer
  -- constructible under the current schema -- `assert_same_day_window()`
  -- (`20260907102000_coordinator_planning_and_same_day_rides.sql`) rejects any ride whose
  -- start and end fall on different Jerusalem calendar days with `ride_must_end_same_day`,
  -- so every ride, by construction, can only ever touch the one or two days the [06:00,22:00)
  -- window computation already handles; a same-day late-evening ride exercises the same
  -- clipping logic without the impossible cross-midnight case. Reported as a correction.)
  insert into public.rides (id, department_id, week_start, car_id, starts_at, ends_at, origin_id,
    destination_id, driver_id, status, created_by)
  values (ride_c_id, dept, w, car_c, (day2 + time '20:00') at time zone 'Asia/Jerusalem',
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
  -- granted (assigned/merged) = 3, unmet (denied/external/waitlisted) = 3, cancelled = 1,
  -- submitted (counts toward total only) = 1, plus a draft and a withdrawn that must be
  -- excluded entirely. total = 8, unmetRate = 3/8, servedRate = 3/8.
  -- req1 (member1, 'work', adults=2 so it can carry one companion below) will be ride A's
  -- driver; req2 (member2, 'work') ride A's passenger; req3 (member1 again, 'childcare')
  -- ride B's driver -- member1's second request, must still count once in distinctPeople.
  insert into public.requests (id, department_id, week_start, requester_id, filed_by, destination_id,
    ride_type_id, trip_shape, depart_at, return_at, adults, submitted_at, status)
  values
    (req1_id, dept, w, member1, member1, dest, ride_type, 'round_trip',
      (day1 + time '08:00') at time zone 'Asia/Jerusalem', (day1 + time '10:00') at time zone 'Asia/Jerusalem',
      2, now(), 'assigned'),
    (req2_id, dept, w, member2, member2, dest, ride_type, 'round_trip',
      (day1 + time '08:00') at time zone 'Asia/Jerusalem', (day1 + time '10:00') at time zone 'Asia/Jerusalem',
      1, now(), 'merged'),
    (req3_id, dept, w, member1, member1, dest, ride_type2, 'round_trip',
      (day1 + time '08:00') at time zone 'Asia/Jerusalem', (day1 + time '10:00') at time zone 'Asia/Jerusalem',
      1, now(), 'assigned');

  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id,
    ride_type_id, trip_shape, depart_at, return_at, adults, submitted_at, status)
  values
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

  -- ride_requests: req1 drives ride A, req2 rides along as passenger on ride A (both
  -- 'work'); req3 drives ride B ('childcare'). Ride C stays unlinked -> 'other' bucket.
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
  values
    (ride_a_id, req1_id, 'driver', 'both', 'keep'),
    (ride_a_id, req2_id, 'passenger', 'both', 'passenger'),
    (ride_b_id, req3_id, 'driver', 'both', 'keep');

  -- request_companions: admin_id rides along with req1 (a profile who filed no request of
  -- their own) -- exercises the "companion" half of distinctPeople.
  insert into public.request_companions (request_id, profile_id)
  values (req1_id, admin_id);

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
  -- earliest = least(min(weeks.week_start), min(rides date), min(requests date)) over the
  -- whole department: this fixture's own `weeks` row at w is earlier than every ride/request
  -- date it inserts (day1 = w+1 at the earliest) and than every seeded row for this
  -- department (current_week_start()/+7, far later than w), so it equals w exactly. p_from
  -- (= w) is therefore not less than earliest, and no from-clamp fires here.
  assert (result ->> 'earliest') = w::text, '(a) earliest mismatch';
  assert (result ->> 'sharedCars')::int = 3, '(a) sharedCars mismatch';
  assert (result -> 'utilization' ->> 'activeHours')::numeric = 5.0, '(a) activeHours: expected 2+1+2=5h, cancelled/private/out-of-window excluded';
  assert (result -> 'utilization' ->> 'capacityHours')::numeric = 3 * 14 * 16, '(a) capacityHours mismatch';
  assert (result -> 'utilization' ->> 'rate')::numeric = round(5.0 / (3*14*16), 4), '(a) utilization rate mismatch';

  assert (result -> 'requests' ->> 'total')::int = 8, '(a) requests.total mismatch';
  assert (result -> 'requests' ->> 'granted')::int = 3, '(a) requests.granted mismatch';
  assert (result -> 'requests' ->> 'unmet')::int = 3, '(a) requests.unmet mismatch';
  assert (result -> 'requests' ->> 'cancelled')::int = 1, '(a) requests.cancelled mismatch';
  assert (result -> 'requests' ->> 'unmetRate')::numeric = round(3.0/8, 4), '(a) unmetRate mismatch';
  assert (result -> 'requests' ->> 'servedRate')::numeric = round(3.0/8, 4), '(a) servedRate mismatch';

  assert (result ->> 'rides')::int = 3, '(a) rides mismatch: A, B and C start in range; cancelled/private do not count';

  -- distinctPeople: served requests' requesters {member1 (req1+req3, once), member2 (req2)}
  -- union rides.driver_id {member1 (A), member1 (B), sadran_id (C, no request of their own)}
  -- union request_companions of served requests {admin_id (req1)} = {member1, member2,
  -- sadran_id, admin_id} = 4. distinctDrivers = distinct rides.driver_id = {member1, sadran_id} = 2.
  assert (result ->> 'distinctPeople')::int = 4, '(a) distinctPeople mismatch';
  assert (result ->> 'distinctDrivers')::int = 2, '(a) distinctDrivers mismatch';

  -- byRideType: ride A (driver req1) -> 'work', 2h; ride B (driver req3) -> 'childcare', 1h;
  -- ride C (no served request at all) -> null-id 'other' bucket, 2h.
  select item into wk_work from jsonb_array_elements(result -> 'byRideType') item where item ->> 'code' = 'work';
  select item into wk_childcare from jsonb_array_elements(result -> 'byRideType') item where item ->> 'code' = 'childcare';
  select item into wk_other from jsonb_array_elements(result -> 'byRideType') item where item -> 'rideTypeId' = 'null'::jsonb;

  assert wk_work is not null, '(a) byRideType must include a work entry';
  assert (wk_work ->> 'rideTypeId') = '00000000-0000-0000-0000-000000000021', '(a) byRideType work rideTypeId mismatch';
  assert (wk_work ->> 'rides')::int = 1, '(a) byRideType work rides mismatch';
  assert (wk_work ->> 'hours')::numeric = 2.0, '(a) byRideType work hours mismatch (ride A, 2h)';

  assert wk_childcare is not null, '(a) byRideType must include a childcare entry';
  assert (wk_childcare ->> 'rides')::int = 1, '(a) byRideType childcare rides mismatch';
  assert (wk_childcare ->> 'hours')::numeric = 1.0, '(a) byRideType childcare hours mismatch (ride B, 1h)';

  assert wk_other is not null, '(a) byRideType must include the null-id other bucket';
  assert (wk_other ->> 'code') = 'other', '(a) byRideType other bucket code mismatch';
  assert (wk_other ->> 'name') is null, '(a) byRideType other bucket has no ride_types name';
  assert (wk_other ->> 'rides')::int = 1, '(a) byRideType other bucket rides mismatch (ride C, unlinked)';
  assert (wk_other ->> 'hours')::numeric = 2.0, '(a) byRideType other bucket hours mismatch (ride C, 2h)';

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
  assert (result -> 'earliest') = 'null'::jsonb, '(d) a department with no weeks/rides/requests at all has a null earliest';

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

  -- (f) from-clamp and to-clamp (20260910098100). A fresh department with exactly one
  -- `weeks` row and no rides/requests: earliest is that row's week_start alone (the other
  -- two LEAST() sources are null and ignored), so this isolates the clamp mechanics from
  -- the (a) fixture's own data.
  select id into clamp_dept from public.create_department('Stats clamp test', 'stats-clamp-test');
  clamp_week := public.current_week_start() - 70;   -- Sunday-aligned, well before today
  -- weeks is RPC-only since 20260910099300 (no direct write policy): seed the fixture row as the owner.
  execute 'reset role';
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
  values (clamp_dept, clamp_week, 'archived', now() - interval '100 days', now() - interval '90 days', now() - interval '89 days');
  execute 'set local role authenticated';
  select (now() at time zone 'Asia/Jerusalem')::date into today_j;

  -- (f1) p_from before earliest is clamped up to earliest; p_to (still in the past) is untouched.
  result2 := public.department_stats(clamp_dept, clamp_week - 10, clamp_week + 5);
  assert (result2 ->> 'earliest') = clamp_week::text, '(f1) earliest mismatch';
  assert (result2 ->> 'from') = clamp_week::text, '(f1) from must be clamped up to earliest, not the requested clamp_week-10';
  assert (result2 ->> 'to') = (clamp_week + 5)::text, '(f1) to must be unchanged (still in the past)';
  assert (result2 ->> 'days')::int = 6, '(f1) days mismatch: clamp_week..clamp_week+5 inclusive';
  assert (result2 ->> 'sharedCars')::int = 0, '(f1) fresh department has no cars';

  -- (f2) p_to after today is clamped down to today; p_from (== earliest) is untouched.
  result2 := public.department_stats(clamp_dept, clamp_week, today_j + 50);
  assert (result2 ->> 'from') = clamp_week::text, '(f2) from must be unchanged (equals earliest already)';
  assert (result2 ->> 'to') = today_j::text, '(f2) to must be clamped down to today, not today_j+50';
  assert (result2 ->> 'days')::int = (today_j - clamp_week + 1), '(f2) days mismatch';

  -- (f3) both clamps apply together.
  result2 := public.department_stats(clamp_dept, clamp_week - 10, today_j + 50);
  assert (result2 ->> 'from') = clamp_week::text, '(f3) from must be clamped up to earliest';
  assert (result2 ->> 'to') = today_j::text, '(f3) to must be clamped down to today';
  assert (result2 ->> 'days')::int = (today_j - clamp_week + 1), '(f3) days mismatch';

  -- (g) pathological case: a department whose only data is a future-dated week, so
  -- earliest > today and the two clamps cross (from-clamp lands after to-clamp). Not an
  -- error -- there is simply no in-range day to report, so days floors at 0 instead of
  -- going negative, and from/to are returned exactly as clamped (from > to is expected here).
  select id into future_dept from public.create_department('Stats future-only test', 'stats-future-only-test');
  future_week := public.current_week_start() + 70;
  -- weeks is RPC-only since 20260910099300 (no direct write policy): seed the fixture row as the owner.
  execute 'reset role';
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
  values (future_dept, future_week, 'open', now() - interval '1 day', now() + interval '60 days', now() + interval '61 days');
  execute 'set local role authenticated';
  result2 := public.department_stats(future_dept, public.current_week_start(), future_week + 5);
  assert (result2 ->> 'earliest') = future_week::text, '(g) earliest mismatch';
  assert (result2 ->> 'from') = future_week::text, '(g) from must be clamped up to earliest even though that lands after today';
  assert (result2 ->> 'to') = today_j::text, '(g) to must be clamped down to today';
  assert (result2 ->> 'days')::int = 0, '(g) days must floor at 0, not go negative, when the clamps cross';
  assert (result2 ->> 'sharedCars')::int = 0, '(g) fresh department has no cars';

  -- ---------------------------------------------------------------------------
  -- (h) Weekly series (item 4): week w is not archived, so its entry is provisional and
  -- computed live -- it must match the aggregate requests/rides figures above exactly,
  -- since every one of this fixture's requests/rides falls inside week w's own 7 days.
  -- Week w2 gets a little of its own data and is marked archived; compute_week_stats()
  -- caches it, and department_stats() must then read that cached row (provisional: false)
  -- instead of recomputing it.
  -- ---------------------------------------------------------------------------
  execute 'reset role';

  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id,
    ride_type_id, trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w2, member1, member1, dest, ride_type, 'round_trip',
    (w2 + 1 + time '08:00') at time zone 'Asia/Jerusalem', (w2 + 1 + time '10:00') at time zone 'Asia/Jerusalem',
    1, now(), 'assigned');

  update public.weeks set phase = 'archived' where department_id = dept and week_start = w2;

  perform public.compute_week_stats(dept, w2);

  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  result := public.department_stats(dept, p_from, p_to);

  select item into wk_w from jsonb_array_elements(result -> 'weekly') item where (item ->> 'weekStart') = w::text;
  select item into wk_w2 from jsonb_array_elements(result -> 'weekly') item where (item ->> 'weekStart') = w2::text;

  assert wk_w is not null, '(h) weekly must include week w';
  assert (wk_w ->> 'provisional')::boolean = true, '(h) week w (not archived) must be provisional';
  assert (wk_w ->> 'total')::int = 8, '(h) week w total mismatch (live)';
  assert (wk_w ->> 'granted')::int = 3, '(h) week w granted mismatch (live)';
  assert (wk_w ->> 'unmet')::int = 3, '(h) week w unmet mismatch (live)';
  assert (wk_w ->> 'cancelled')::int = 1, '(h) week w cancelled mismatch (live)';
  assert (wk_w ->> 'rides')::int = 3, '(h) week w rides mismatch (live)';

  assert wk_w2 is not null, '(h) weekly must include week w2';
  assert (wk_w2 ->> 'provisional')::boolean = false, '(h) week w2 (archived, cached) must not be provisional';
  assert (wk_w2 ->> 'total')::int = 1, '(h) week w2 total mismatch (cached)';
  assert (wk_w2 ->> 'granted')::int = 1, '(h) week w2 granted mismatch (cached)';
  assert (wk_w2 ->> 'unmet')::int = 0, '(h) week w2 unmet mismatch (cached)';
  assert (wk_w2 ->> 'cancelled')::int = 0, '(h) week w2 cancelled mismatch (cached)';
  assert (wk_w2 ->> 'rides')::int = 0, '(h) week w2 rides mismatch (cached)';

  perform 1 from public.week_stats where department_id = dept and week_start = w2
    and total_requests = 1 and granted = 1 and unmet = 0 and cancelled = 0 and rides = 0;
  assert found, '(h) compute_week_stats must upsert week_stats matching the RPC''s own cached figures';

  -- ---------------------------------------------------------------------------
  -- (i) RLS on week_stats mirrors department_stats()'s own authorization: the department's
  -- Sadran reads the cached row; a plain member sees none (permissive SELECT policy whose
  -- USING evaluates false, not an error -- same pattern as every other read-only reference
  -- table in this suite, e.g. TEST 13 of rls_smoke.sql for weekday_labels).
  -- ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member1, 'role', 'authenticated')::text, true);
  select count(*) into rls_count from public.week_stats where department_id = dept and week_start = w2;
  assert rls_count = 0, '(i) a plain member must not read week_stats';

  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran_id, 'role', 'authenticated')::text, true);
  select count(*) into rls_count from public.week_stats where department_id = dept and week_start = w2;
  assert rls_count = 1, '(i) the department''s Sadran must read the cached week_stats row';

  -- ---------------------------------------------------------------------------
  -- (j) advance_week_phases() archiving a week populates week_stats via the cron hook
  -- itself, not just a direct compute_week_stats() call: a separate far-past week (w3),
  -- currently `live`, whose window closed long ago.
  -- ---------------------------------------------------------------------------
  execute 'reset role';

  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
  values (dept, w3, 'solving', now() - interval '30 days', now() - interval '20 days', now() - interval '19 days');

  insert into public.siddur_versions (department_id, week_start, snapshot, published_by, published_at)
  values (dept, w3, '{}'::jsonb, sadran_id, now() - interval '19 days')
  returning id into w3_version_id;

  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'live', published_version_id = w3_version_id
  where department_id = dept and week_start = w3;
  perform set_config('app.in_publish', 'off', true);

  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id,
    ride_type_id, trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w3, member1, member1, dest, ride_type, 'round_trip',
    (w3 + 1 + time '08:00') at time zone 'Asia/Jerusalem', (w3 + 1 + time '10:00') at time zone 'Asia/Jerusalem',
    1, now(), 'assigned');

  assert not exists(select 1 from public.week_stats where department_id = dept and week_start = w3),
    '(j) fixture setup: week_stats must not already have a row for w3';

  -- p_now is w3+8 (a far-past Monday, well before any seeded department's real current
  -- week), so only w3 -- not the seeded live real-time week of any department -- crosses
  -- the "(week_start + 7) <= p_now" archiving threshold.
  perform public.advance_week_phases(((w3 + 8) + time '09:00') at time zone 'Asia/Jerusalem');

  assert (select phase from public.weeks where department_id = dept and week_start = w3) = 'archived',
    '(j) advance_week_phases must archive a live week whose window closed long ago';

  perform 1 from public.week_stats where department_id = dept and week_start = w3
    and total_requests = 1 and granted = 1;
  assert found, '(j) advance_week_phases archiving a week must populate week_stats';
end $$;

reset role;
rollback;
