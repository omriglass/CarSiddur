-- Multi-day requests / "series" (REQ §13.77, DATA_MODEL §3.2/§3.3/§5).
-- Transactional: every fixture row is rolled back at the end, so this is safe to run
-- repeatedly against a seeded local database. Uses the seeded נבו department
-- (…0001, home …0010), Sadran …0102, member …0103, cars …0040/…0041/…0042,
-- destination חיפה …0011, ride type …0021, on far-future weeks so nothing collides
-- with the demo data or the other suites.
begin;

create temporary table series_ids(k text primary key, id uuid);
grant all on series_ids to authenticated;

-- (a) submit_series_request splits a 3-day span into 3 linked legs with the right windows,
-- (b) and the legs do not raise the duplicate-overlap warning against each other.
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  member uuid := '00000000-0000-0000-0000-000000000103';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start() + 322;
  result jsonb; legs record;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');
  insert into series_ids values ('w1', null);

  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  result := public.submit_series_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'destination_id', dest, 'ride_type_id', ride_type,
    'trip_shape', 'round_trip', 'adults', 1,
    'depart_at', ((w + 1) + time '09:00') at time zone 'Asia/Jerusalem',
    'return_at', ((w + 3) + time '17:00') at time zone 'Asia/Jerusalem'));
  insert into series_ids values ('s1', (result ->> 'series_id')::uuid);

  assert jsonb_array_length(result -> 'request_ids') = 3, 'series did not produce one leg per day';
  assert not (result -> 'warnings' @> '"DUPLICATE_OVERLAP"'::jsonb), 'series legs warned as duplicates of each other';

  select count(*) filter (where series_index = 1
      and depart_at = ((w+1) + time '09:00') at time zone 'Asia/Jerusalem'
      and return_at = ((w+1) + time '23:59') at time zone 'Asia/Jerusalem') as first,
    count(*) filter (where series_index = 2
      and depart_at = ((w+2)::timestamp) at time zone 'Asia/Jerusalem'
      and return_at = ((w+2) + time '23:59') at time zone 'Asia/Jerusalem') as middle,
    count(*) filter (where series_index = 3
      and depart_at = ((w+3)::timestamp) at time zone 'Asia/Jerusalem'
      and return_at = ((w+3) + time '17:00') at time zone 'Asia/Jerusalem') as last,
    count(*) filter (where week_start = w) as same_week,
    count(distinct series_count) as counts, max(series_count) as total
  into legs from public.requests where series_id = (select id from series_ids where k = 's1');
  assert legs.first = 1, 'first leg window wrong';
  assert legs.middle = 1, 'middle leg window wrong (expected 00:00 -> 23:59:00)';
  assert legs.last = 1, 'last leg window wrong';
  assert legs.same_week = 3, 'legs not keyed to the right week';
  assert legs.counts = 1 and legs.total = 3, 'series_count not consistent across legs';

  -- Editing a leg is refused in v1: cancel and resubmit instead.
  begin
    perform public.submit_request(jsonb_build_object('request_id', (result -> 'request_ids' ->> 0)::uuid,
      'department_id', dept, 'week_start', w, 'destination_id', dest, 'ride_type_id', ride_type,
      'trip_shape', 'round_trip', 'adults', 1, 'expected_version', 1,
      'depart_at', ((w+1) + time '10:00') at time zone 'Asia/Jerusalem',
      'return_at', ((w+1) + time '23:59') at time zone 'Asia/Jerusalem'));
    raise exception 'series leg edit was accepted';
  exception when sqlstate 'MDR02' then null; end;
end $$;

-- (c) place_series puts every leg on one car, with no turnaround conflict at the midnight
-- seams and an intact location chain, and (d) refuses a car that is busy on a middle day.
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  home uuid := '00000000-0000-0000-0000-000000000010';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  car uuid := '00000000-0000-0000-0000-000000000040';
  busy uuid := '00000000-0000-0000-0000-000000000041';
  w date := public.current_week_start() + 322;
  s1 uuid := (select id from series_ids where k = 's1');
  result jsonb; rides record;
begin
  -- ...041 is taken in the middle of the span, so it can never host the series.
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, notes, status, created_by)
  values (dept, w, busy, ((w+2) + time '08:00') at time zone 'Asia/Jerusalem',
    ((w+2) + time '10:00') at time zone 'Asia/Jerusalem', home, home, null, 'series fixture blocker',
    'confirmed', sadran);

  begin
    perform public.place_series(s1, busy, false, null);
    raise exception 'place_series accepted a car busy in the middle of the span';
  exception when sqlstate 'MDR03' then null; end;

  result := public.place_series(s1, car, true, 'SERIES_PLACED');
  assert jsonb_array_length(result -> 'ride_ids') = 3, 'place_series did not create one ride per leg';

  select count(*) as n, count(distinct car_id) as cars,
    count(*) filter (where origin_id = home and destination_id = dest) as first,
    count(*) filter (where origin_id = dest and destination_id = dest) as middle,
    count(*) filter (where origin_id = dest and destination_id = home) as last,
    count(*) filter (where series_id = s1) as tagged
  into rides from public.rides where series_id = s1 and status <> 'cancelled';
  assert rides.n = 3 and rides.cars = 1, 'series legs did not land on one single car';
  assert rides.first = 1 and rides.middle = 1 and rides.last = 1, 'series leg origin/destination chain wrong';
  assert rides.tagged = 3, 'rides.series_id not denormalized';
  assert (select count(*) = 3 from public.requests
          where series_id = s1 and status = 'assigned' and status_reason = 'SERIES_PLACED'),
    'series legs not marked assigned/SERIES_PLACED';

  perform public.assert_car_chain(car, w);      -- must not raise car_away_at_day_end
end $$;

-- (f) move_series moves every leg to a free car, and refuses a busy one.
do $$
declare
  w date := public.current_week_start() + 322;
  free_car uuid := '00000000-0000-0000-0000-000000000042';
  busy uuid := '00000000-0000-0000-0000-000000000041';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  s1 uuid := (select id from series_ids where k = 's1');
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  begin
    perform public.move_series(s1, busy, null);
    raise exception 'move_series accepted a busy car';
  exception when sqlstate 'MDR03' then null; end;
  assert (select count(*) = 3 from public.rides where series_id = s1 and status <> 'cancelled'
          and car_id = '00000000-0000-0000-0000-000000000040'), 'failed move did not leave the series in place';

  perform public.move_series(s1, free_car, null);
  assert (select count(*) = 3 from public.rides where series_id = s1 and status <> 'cancelled'
          and car_id = free_car), 'move_series did not move every leg';
  perform public.assert_car_chain(free_car, w);
end $$;

-- edit_ride routes a series leg's car change through move_series, refuses a busy car, and
-- refuses a time change on a middle leg.
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  w date := public.current_week_start() + 322;
  busy uuid := '00000000-0000-0000-0000-000000000041';
  target_car uuid := '00000000-0000-0000-0000-000000000040';
  s1 uuid := (select id from series_ids where k = 's1');
  leg public.rides%rowtype; payload jsonb;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  select * into leg from public.rides where series_id = s1 and status <> 'cancelled' order by starts_at limit 1 offset 1;
  payload := jsonb_build_object('id', leg.id, 'department_id', dept, 'week_start', w,
    'starts_at', leg.starts_at, 'ends_at', leg.ends_at,
    'origin_id', leg.origin_id, 'destination_id', leg.destination_id);

  begin
    perform public.edit_ride(payload || jsonb_build_object('car_id', busy), leg.version);
    raise exception 'edit_ride moved a series onto a busy car';
  exception when sqlstate 'MDR03' then null; end;

  perform public.edit_ride(payload || jsonb_build_object('car_id', target_car), leg.version);
  assert (select count(*) = 3 from public.rides where series_id = s1 and status <> 'cancelled'
          and car_id = target_car), 'edit_ride did not move every leg of the series';

  select * into leg from public.rides where id = leg.id;
  begin
    perform public.edit_ride(jsonb_build_object('id', leg.id, 'department_id', dept, 'week_start', w,
      'car_id', leg.car_id, 'starts_at', leg.starts_at,
      'ends_at', leg.ends_at - interval '1 hour',
      'origin_id', leg.origin_id, 'destination_id', leg.destination_id), leg.version);
    raise exception 'a middle leg accepted a time change';
  exception when sqlstate 'MDR02' then null; end;
end $$;

-- (g) cancelling one leg's ride cancels the whole series.
do $$
declare
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  s1 uuid := (select id from series_ids where k = 's1');
  target uuid; v int;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  select id, version into target, v from public.rides
  where series_id = s1 and status <> 'cancelled' order by starts_at limit 1 offset 1;
  perform public.cancel_ride(target, 'CANCELLED_BY_MEMBER', v);
  assert (select count(*) = 0 from public.rides where series_id = s1 and status <> 'cancelled'),
    'cancelling one leg left other legs of the series on the car';
  assert (select count(*) = 3 from public.requests where series_id = s1 and status = 'cancelled'),
    'cancelling one leg did not cancel every leg request';
end $$;

-- (e) a series that crosses Saturday -> Sunday: apply_solver_result places the in-week legs
-- and place_series materializes the next week's leg as a pinned SERIES_CARRY_OVER ride that
-- the next week's full solve leaves alone; a series whose car is not free for the whole span
-- is rolled back on its own and reported in `skippedSeries`.
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  member uuid := '00000000-0000-0000-0000-000000000103';
  member2 uuid := '00000000-0000-0000-0000-000000000104';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  home uuid := '00000000-0000-0000-0000-000000000010';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  good uuid := '00000000-0000-0000-0000-000000000041';
  doomed uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 336;
  s2 uuid; s5 uuid; result jsonb; payload_rides jsonb := '[]'::jsonb; carry record; leg record;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days'),
           (dept, w + 7, 'open', now() - interval '1 day', now() + interval '8 days', now() + interval '9 days');

  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  result := public.submit_series_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'destination_id', dest, 'ride_type_id', ride_type,
    'trip_shape', 'round_trip', 'adults', 1,
    'depart_at', ((w + 5) + time '09:00') at time zone 'Asia/Jerusalem',
    'return_at', ((w + 7) + time '17:00') at time zone 'Asia/Jerusalem'));
  s2 := (result ->> 'series_id')::uuid;
  insert into series_ids values ('s2', s2);
  assert (select count(*) = 1 from public.requests where series_id = s2 and week_start = w + 7),
    'the Sunday leg was not filed against the next week';

  perform set_config('request.jwt.claims', jsonb_build_object('sub', member2, 'role', 'authenticated')::text, true);
  result := public.submit_series_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'destination_id', dest, 'ride_type_id', ride_type,
    'trip_shape', 'round_trip', 'adults', 1,
    'depart_at', ((w + 5) + time '09:00') at time zone 'Asia/Jerusalem',
    'return_at', ((w + 7) + time '17:00') at time zone 'Asia/Jerusalem'));
  s5 := (result ->> 'series_id')::uuid;

  -- ...040 is taken next Sunday, so the second series can never have the whole span.
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, notes, status, created_by)
  values (dept, w + 7, doomed, ((w + 7) + time '06:00') at time zone 'Asia/Jerusalem',
    ((w + 7) + time '18:00') at time zone 'Asia/Jerusalem', home, home, null, 'series carry-over blocker',
    'confirmed', sadran);

  -- The solver only ever sees this week's legs.
  for leg in select q.*, case when q.series_id = s2 then good else doomed end as car
             from public.requests q where q.series_id in (s2, s5) and q.week_start = w
             order by q.series_id, q.series_index loop
    payload_rides := payload_rides || jsonb_build_array(jsonb_build_object(
      'car_id', leg.car, 'starts_at', leg.depart_at, 'ends_at', leg.return_at,
      'origin_id', case when leg.series_index = 1 then home else dest end,
      'destination_id', case when leg.series_index = leg.series_count then home else dest end,
      'driver_id', leg.requester_id,
      'served', jsonb_build_array(jsonb_build_object('request_id', leg.id, 'role', 'driver',
        'leg', 'both', 'car_mode', 'keep'))));
  end loop;

  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  result := public.apply_solver_result(dept, w, jsonb_build_object('mode', 'full',
    'rides', payload_rides, 'request_statuses', '[]'::jsonb,
    'policy_version_id', '00000000-0000-0000-0000-000000000031', 'input_hash', 'series-apply',
    'solver_version', 'test', 'started_at', now()::text, 'finished_at', now()::text, 'duration_ms', 0,
    'summary', '{}'::jsonb));

  select count(*) as n, bool_and(is_pinned) as pinned, min(pin_reason) as reason
  into carry from public.rides where series_id = s2 and week_start = w + 7 and status <> 'cancelled';
  assert carry.n = 1 and carry.pinned and carry.reason = 'SERIES_CARRY_OVER',
    'apply_solver_result did not materialize the next week leg as a pinned SERIES_CARRY_OVER ride';
  assert (select count(*) = 3 from public.rides where series_id = s2 and status <> 'cancelled' and car_id = good),
    'the carry-over leg did not land on the car the solver chose';

  assert jsonb_array_length(result -> 'skippedSeries') = 1
     and (result -> 'skippedSeries' -> 0 ->> 'series_id')::uuid = s5,
    'the unplaceable series was not reported in skippedSeries';
  assert not exists (select 1 from public.rides where series_id = s5 and status <> 'cancelled'),
    'the unplaceable series kept this apply''s rides';
  assert (select count(*) = 3 from public.requests
          where series_id = s5 and status = 'submitted' and status_reason = 'SERIES_CAR_UNAVAILABLE'),
    'the unplaceable series legs were not returned to submitted/SERIES_CAR_UNAVAILABLE';

  perform public.assert_car_chain(good, w);
  perform public.assert_car_chain(good, w + 7);   -- chain seeded from the previous week's leg

  perform public.apply_solver_result(dept, w + 7, jsonb_build_object('mode', 'full',
    'rides', '[]'::jsonb, 'request_statuses', '[]'::jsonb,
    'policy_version_id', '00000000-0000-0000-0000-000000000031', 'input_hash', 'series-carry-over',
    'solver_version', 'test', 'started_at', now()::text, 'finished_at', now()::text, 'duration_ms', 0,
    'summary', '{}'::jsonb));
  assert (select count(*) = 1 from public.rides where series_id = s2 and week_start = w + 7 and status <> 'cancelled'),
    'a full solve of the next week deleted the carry-over leg';
end $$;

-- (h) withdrawing one leg withdraws the series and frees the car,
-- (i) series legs never enter waiting-list groups or freed-slot matching,
-- (j) a span that reaches past the last open week is refused.
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  member uuid := '00000000-0000-0000-0000-000000000103';
  member2 uuid := '00000000-0000-0000-0000-000000000104';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  home uuid := '00000000-0000-0000-0000-000000000010';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start() + 350;
  s3 uuid; s4 uuid; result jsonb; car uuid; offer uuid; cancelled uuid; pubver uuid;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');

  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  result := public.submit_series_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'destination_id', dest, 'ride_type_id', ride_type,
    'trip_shape', 'round_trip', 'adults', 1,
    'depart_at', ((w + 1) + time '09:00') at time zone 'Asia/Jerusalem',
    'return_at', ((w + 2) + time '02:00') at time zone 'Asia/Jerusalem'));
  s3 := (result ->> 'series_id')::uuid;
  perform public.place_series(s3, '00000000-0000-0000-0000-000000000040'::uuid, false, null);

  -- (h) one leg withdrawn -> both legs withdrawn, both rides released.
  perform public.withdraw_request((result -> 'request_ids' ->> 1)::uuid,
    (select version from public.requests where id = (result -> 'request_ids' ->> 1)::uuid));
  assert (select count(*) = 2 from public.requests where series_id = s3 and status = 'withdrawn'),
    'withdrawing one leg did not withdraw the series';
  assert (select count(*) = 0 from public.rides where series_id = s3 and status <> 'cancelled'),
    'withdrawing the series did not release the car';

  -- (j) REQ §13.77: a span reaching one week past the last week the department has opened
  -- now materializes that week as `upcoming` instead of being refused outright — MDR01 is
  -- reserved for a genuinely impossible span (see supabase/tests/upcoming_weeks.sql, which
  -- also covers the upcoming -> open phase lifecycle and window_open notification).
  result := public.submit_series_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'destination_id', dest, 'ride_type_id', ride_type,
    'trip_shape', 'round_trip', 'adults', 1,
    'depart_at', ((w + 6) + time '09:00') at time zone 'Asia/Jerusalem',
    'return_at', ((w + 7) + time '17:00') at time zone 'Asia/Jerusalem'));
  assert jsonb_array_length(result -> 'request_ids') = 2,
    'a series crossing into an unopened week did not produce both legs';
  assert (select phase from public.weeks where department_id = dept and week_start = w + 7) = 'upcoming',
    'a series leg one week beyond the opened horizon did not materialize its week as upcoming';

  -- An ordinary (non-series) request against that same upcoming week is still refused.
  begin
    perform public.submit_request(jsonb_build_object('department_id', dept, 'week_start', w + 7,
      'destination_id', dest, 'ride_type_id', ride_type, 'trip_shape', 'round_trip', 'adults', 1,
      'depart_at', ((w + 8) + time '09:00') at time zone 'Asia/Jerusalem',
      'return_at', ((w + 8) + time '17:00') at time zone 'Asia/Jerusalem'));
    raise exception 'an ordinary request into an upcoming week was accepted';
  exception when others then
    if sqlerrm <> 'week_not_open' then raise; end if;
  end;

  -- (i) a series with no car anywhere waits as one item, outside waiting-list groups …
  foreach car in array array['00000000-0000-0000-0000-000000000040'::uuid,
                             '00000000-0000-0000-0000-000000000041'::uuid,
                             '00000000-0000-0000-0000-000000000042'::uuid] loop
    insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
      driver_id, notes, status, created_by)
    values (dept, w, car, ((w + 4) + time '06:00') at time zone 'Asia/Jerusalem',
      ((w + 4) + time '23:59') at time zone 'Asia/Jerusalem', home, home, null, 'series fixture blocker',
      'confirmed', sadran);
  end loop;
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by)
    values (dept, w, '{}', sadran) returning id into pubver;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pubver, published_days = array[w+4, w+5]
  where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);

  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  result := public.submit_series_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'destination_id', dest, 'ride_type_id', ride_type,
    'trip_shape', 'round_trip', 'adults', 1,
    'depart_at', ((w + 4) + time '09:00') at time zone 'Asia/Jerusalem',
    'return_at', ((w + 5) + time '02:00') at time zone 'Asia/Jerusalem'));
  s4 := (result ->> 'series_id')::uuid;
  assert (select count(*) = 2 from public.requests
          where series_id = s4 and status = 'waitlisted' and status_reason = 'WAITLISTED_SERIES_NO_CAR'),
    'an unplaceable series did not waitlist every leg as WAITLISTED_SERIES_NO_CAR';
  assert not exists (select 1 from public.waitlist_group_members m join public.requests q on q.id = m.request_id
                     where q.series_id = s4), 'a series leg joined a contested waiting-list group';

  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  perform public.form_waitlist_groups(dept, w, w + 4);
  assert not exists (select 1 from public.waitlist_group_members m join public.requests q on q.id = m.request_id
                     where q.series_id = s4), 'form_waitlist_groups clustered a series leg';

  -- … and outside freed-slot matching, even when the window fits.
  select id into cancelled from public.rides
  where department_id = dept and week_start = w and car_id = '00000000-0000-0000-0000-000000000040';
  insert into public.freed_slot_offers(department_id, week_start, car_id, cancelled_ride_id, starts_at, ends_at, expires_at)
  values (dept, w, '00000000-0000-0000-0000-000000000040', cancelled,
    ((w + 5) + time '00:00') at time zone 'Asia/Jerusalem',
    ((w + 5) + time '06:00') at time zone 'Asia/Jerusalem', now() + interval '1 day')
  returning id into offer;
  assert not exists (select 1 from public.freed_slot_candidates(offer) c
                     join public.requests q on q.id = c.request_id where q.series_id = s4),
    'a series leg was offered a single-day freed slot';
end $$;

rollback;
