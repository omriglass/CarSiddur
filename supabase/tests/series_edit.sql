-- Editing a multi-day request (REQ §13.142, owner 2026-10-21): submit_series_request with `series_id` replaces
-- the series. Transactional; seeded נבו department (…0001, home …0010), Sadran …0102, members …0103/…0104,
-- destination חיפה …0011, ride type …0021, far-future weeks so nothing collides with demo data or other suites.
begin;

create temporary table edit_ids(k text primary key, id uuid);
grant all on edit_ids to authenticated;

-- (a) open week: a 3-day series edited to 2 days with other times — old legs closed as SERIES_EDITED, a new
-- 2-leg series for the same requester; (b) an unrelated member is refused; (c) shrinking to one day files an
-- ordinary request.
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  member uuid := '00000000-0000-0000-0000-000000000103';
  other uuid := '00000000-0000-0000-0000-000000000104';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start() + 413;
  base jsonb;
  first_result jsonb; edited jsonb; single jsonb;
  old_series uuid; head_version int; legs record;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');
  base := jsonb_build_object('department_id', dept, 'week_start', w, 'destination_id', dest, 'ride_type_id', ride_type,
    'trip_shape', 'round_trip', 'trip_type', 'round_trip', 'adults', 1);

  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  first_result := public.submit_series_request(base || jsonb_build_object(
    'depart_at', ((w + 1) + time '09:00') at time zone 'Asia/Jerusalem',
    'return_at', ((w + 3) + time '17:00') at time zone 'Asia/Jerusalem'));
  old_series := (first_result ->> 'series_id')::uuid;
  select version into head_version from public.requests where series_id = old_series and series_index = 1;

  -- (b) someone unrelated to the request cannot edit it
  perform set_config('request.jwt.claims', jsonb_build_object('sub', other, 'role', 'authenticated')::text, true);
  begin
    perform public.submit_series_request(base || jsonb_build_object('series_id', old_series,
      'depart_at', ((w + 2) + time '08:00') at time zone 'Asia/Jerusalem',
      'return_at', ((w + 3) + time '18:00') at time zone 'Asia/Jerusalem'));
    raise exception 'an unrelated member edited the series';
  exception when raise_exception then if sqlerrm <> 'not_authorized' then raise; end if; end;

  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  -- a stale version is refused
  begin
    perform public.submit_series_request(base || jsonb_build_object('series_id', old_series, 'expected_version', head_version + 5,
      'depart_at', ((w + 2) + time '08:00') at time zone 'Asia/Jerusalem',
      'return_at', ((w + 3) + time '18:00') at time zone 'Asia/Jerusalem'));
    raise exception 'a stale series edit was accepted';
  exception when others then if sqlerrm not like '%stale%' then raise; end if; end;

  edited := public.submit_series_request(base || jsonb_build_object('series_id', old_series, 'expected_version', head_version,
    'depart_at', ((w + 2) + time '08:00') at time zone 'Asia/Jerusalem',
    'return_at', ((w + 3) + time '18:00') at time zone 'Asia/Jerusalem'));
  assert (edited ->> 'replaced_series_id')::uuid = old_series, '(a) the result names the replaced series';
  assert jsonb_array_length(edited -> 'request_ids') = 2, '(a) the new span has one leg per day';
  assert (select bool_and(status = 'withdrawn' and status_reason = 'SERIES_EDITED') from public.requests where series_id = old_series),
    '(a) every old leg is closed as SERIES_EDITED';
  select count(*) as n, bool_and(requester_id = member) as same_person,
    min(depart_at) filter (where series_index = 1) as dep, max(return_at) filter (where series_index = 2) as ret
  into legs from public.requests where series_id = (edited ->> 'series_id')::uuid;
  assert legs.n = 2 and legs.same_person, '(a) the new series is the same person''s, two legs';
  assert legs.dep = ((w + 2) + time '08:00') at time zone 'Asia/Jerusalem'
     and legs.ret = ((w + 3) + time '18:00') at time zone 'Asia/Jerusalem', '(a) the new span has the edited times';

  -- (c) one day: an ordinary request replaces the series
  single := public.submit_series_request(base || jsonb_build_object('series_id', (edited ->> 'series_id')::uuid,
    'depart_at', ((w + 4) + time '08:00') at time zone 'Asia/Jerusalem',
    'return_at', ((w + 4) + time '12:00') at time zone 'Asia/Jerusalem'));
  assert (select series_id is null and status not in ('withdrawn', 'cancelled') from public.requests where id = (single ->> 'request_id')::uuid),
    '(c) a one-day edit files an ordinary request';
  assert not exists (select 1 from public.requests where series_id = (edited ->> 'series_id')::uuid and status not in ('withdrawn', 'cancelled')),
    '(c) the replaced series has no active leg';
end $$;

-- (d) published week: the edited series keeps its car when that car is free for the new span;
-- (e) when no car is free for it, the edit asks first (probe / no change), and only a confirmed edit releases the booking.
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  member uuid := '00000000-0000-0000-0000-000000000103';
  other uuid := '00000000-0000-0000-0000-000000000104';
  home uuid := '00000000-0000-0000-0000-000000000010';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  car uuid;
  w date := public.current_week_start() + 420;
  base jsonb;
  s0 uuid; edited jsonb; probe jsonb; asked jsonb; confirmed jsonb; pub uuid;
  c record;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'solving', now() - interval '3 days', now() - interval '2 days', now() - interval '1 day');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', sadran) returning id into pub;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set phase = 'published', published_version_id = pub, published_at = now(),
    published_days = array[w, w+1, w+2, w+3, w+4, w+5, w+6]
  where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);
  base := jsonb_build_object('department_id', dept, 'week_start', w, 'destination_id', dest, 'ride_type_id', ride_type,
    'trip_shape', 'round_trip', 'trip_type', 'round_trip', 'adults', 1);

  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  s0 := (public.submit_series_request(base || jsonb_build_object(
    'depart_at', ((w + 1) + time '09:00') at time zone 'Asia/Jerusalem',
    'return_at', ((w + 2) + time '17:00') at time zone 'Asia/Jerusalem')) ->> 'series_id')::uuid;
  -- a published week places it right away: remember the car it got
  select rd.car_id into car from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
    join public.requests q on q.id = rr.request_id where q.series_id = s0 and rd.status <> 'cancelled' limit 1;
  assert car is not null, 'fixture: the series was placed on publish-day filing';
  assert (select bool_and(rd.car_id = car) from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
          join public.requests q on q.id = rr.request_id where q.series_id = s0 and rd.status <> 'cancelled'), 'fixture: series on the car';

  -- (d) extend by a day: the same car takes it
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  edited := public.submit_series_request(base || jsonb_build_object('series_id', s0,
    'depart_at', ((w + 1) + time '09:00') at time zone 'Asia/Jerusalem',
    'return_at', ((w + 3) + time '17:00') at time zone 'Asia/Jerusalem'));
  assert (select bool_and(q.status = 'assigned') from public.requests q where q.series_id = (edited ->> 'series_id')::uuid),
    '(d) the edited series is placed';
  assert (select bool_and(rd.car_id = car) from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
          join public.requests q on q.id = rr.request_id where q.series_id = (edited ->> 'series_id')::uuid and rd.status <> 'cancelled'),
    '(d) the edited series keeps its car';

  -- (e) every shared car is busy on a new last day: the edit would lose the booking
  perform set_config('request.jwt.claims', '{}', true);
  for c in select id from public.cars where department_id = dept and type = 'shared' and status = 'active' loop
    insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
    values (dept, w, c.id, ((w + 5) + time '06:00') at time zone 'Asia/Jerusalem', ((w + 5) + time '22:00') at time zone 'Asia/Jerusalem',
      home, home, other, 'confirmed', sadran);
  end loop;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  probe := public.submit_series_request(base || jsonb_build_object('series_id', (edited ->> 'series_id')::uuid, 'probe_only', true,
    'depart_at', ((w + 1) + time '09:00') at time zone 'Asia/Jerusalem',
    'return_at', ((w + 5) + time '17:00') at time zone 'Asia/Jerusalem'));
  assert (probe ->> 'would_lose_booking')::boolean, '(e) the probe reports the lost booking';
  asked := public.submit_series_request(base || jsonb_build_object('series_id', (edited ->> 'series_id')::uuid,
    'depart_at', ((w + 1) + time '09:00') at time zone 'Asia/Jerusalem',
    'return_at', ((w + 5) + time '17:00') at time zone 'Asia/Jerusalem'));
  assert asked ->> 'needs_confirmation' = 'release_to_waitlist', '(e) an unconfirmed edit asks first';
  assert (select bool_and(status = 'assigned') from public.requests where series_id = (edited ->> 'series_id')::uuid),
    '(e) an unconfirmed edit changes nothing';
  confirmed := public.submit_series_request(base || jsonb_build_object('series_id', (edited ->> 'series_id')::uuid, 'confirm_release', true,
    'depart_at', ((w + 1) + time '09:00') at time zone 'Asia/Jerusalem',
    'return_at', ((w + 5) + time '17:00') at time zone 'Asia/Jerusalem'));
  assert (select bool_and(status = 'withdrawn') from public.requests where series_id = (edited ->> 'series_id')::uuid),
    '(e) a confirmed edit releases the old series';
  assert (select bool_and(status = 'waitlisted') from public.requests where series_id = (confirmed ->> 'series_id')::uuid),
    '(e) the new span waits for a car';
end $$;

-- (f) R13B5: open week — a series the Sadran placed (draft) keeps its car through a member's edit when the car is free.
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  member uuid := '00000000-0000-0000-0000-000000000103';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  car uuid := '00000000-0000-0000-0000-000000000041';
  w date := public.current_week_start() + 427;
  base jsonb; s0 uuid; edited jsonb;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');
  base := jsonb_build_object('department_id', dept, 'week_start', w, 'destination_id', dest, 'ride_type_id', ride_type,
    'trip_shape', 'round_trip', 'trip_type', 'round_trip', 'adults', 1);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  s0 := (public.submit_series_request(base || jsonb_build_object(
    'depart_at', ((w + 1) + time '09:00') at time zone 'Asia/Jerusalem',
    'return_at', ((w + 2) + time '17:00') at time zone 'Asia/Jerusalem')) ->> 'series_id')::uuid;
  perform set_config('request.jwt.claims', '{}', true);
  perform public.place_series(s0, car, false, null);           -- the Sadran's (solver's) draft placement
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  edited := public.submit_series_request(base || jsonb_build_object('series_id', s0,
    'depart_at', ((w + 1) + time '10:00') at time zone 'Asia/Jerusalem',
    'return_at', ((w + 3) + time '17:00') at time zone 'Asia/Jerusalem'));
  assert (select bool_and(rd.car_id = car) and count(*) = 3 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
          join public.requests q on q.id = rr.request_id where q.series_id = (edited ->> 'series_id')::uuid and rd.status <> 'cancelled'),
    '(f) the edited series keeps its draft car in an open week';
end $$;

rollback;
