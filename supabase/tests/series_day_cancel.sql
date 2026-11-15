-- R20H1 (owner 2026-11-14): "לבטל רק את היום הזה" on one day of a multi-day ride (`cancel_series_day`).
--   TEST 1  the member cancels the middle day: that day's ride and request go, the days before and after stay two series
--           on the same car with their own times; the person on that day hears once (the cancel), not "ride edited"
--   TEST 2  the Sadran cancels the first day of a two-day part with "הנסיעה כבר לא רלוונטית": the day's request is
--           closed, the other day stays on its ride as an ordinary request
--   TEST 3  refusals: a stale version, an unrelated member, a ride with no series
-- Transactional, rolled back at the end.
begin;

create temporary table sdc(k text primary key, id uuid);

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  member uuid := '00000000-0000-0000-0000-000000000103';
  other uuid := '00000000-0000-0000-0000-000000000104';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  car uuid := '00000000-0000-0000-0000-000000000041';
  w date := public.current_week_start() + 434;
  base jsonb; res jsonb; series uuid; v uuid; mid_ride uuid; n_before int; n_edit int;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');
  base := jsonb_build_object('department_id', dept, 'week_start', w, 'destination_id', dest, 'ride_type_id', ride_type,
    'trip_shape', 'round_trip', 'trip_type', 'round_trip', 'adults', 1);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  res := public.submit_series_request(base || jsonb_build_object(
    'depart_at', ((w + 1) + time '09:00') at time zone 'Asia/Jerusalem',
    'return_at', ((w + 5) + time '17:00') at time zone 'Asia/Jerusalem'));
  series := (res ->> 'series_id')::uuid;
  -- the week is published, then the Sadran places the series (confirmed rides)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by) values (dept, w, '{}', sadran) returning id into v;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set published_days = array[w, w + 1, w + 2, w + 3, w + 4, w + 5, w + 6], phase = 'published', published_version_id = v
   where department_id = dept and week_start = w;
  perform set_config('app.in_publish', 'off', true);
  perform public.place_series_on_car(series, car);
  select r.id into mid_ride from public.rides r join public.ride_requests rr on rr.ride_id = r.id join public.requests q on q.id = rr.request_id
   where q.series_id = series and q.series_index = 3 and r.status <> 'cancelled';
  assert mid_ride is not null and (select status from public.rides where id = mid_ride) = 'confirmed', 'setup: day 3 is a confirmed ride';
  -- someone else rides along on day 3
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  perform public.add_ride_passengers(mid_ride, (select version from public.rides where id = mid_ride),
    jsonb_build_array(jsonb_build_object('person_id', other, 'display_name', 'Other', 'seat_kind', 'adult')));
  insert into sdc values ('series', series), ('mid_ride', mid_ride);
end $$;
set constraints all immediate;
set constraints all deferred;

-- TEST 1
do $$
declare
  member uuid := '00000000-0000-0000-0000-000000000103';
  other uuid := '00000000-0000-0000-0000-000000000104';
  series uuid := (select id from sdc where k = 'series');
  mid_ride uuid := (select id from sdc where k = 'mid_ride');
  mid_req uuid; times_before jsonb; after_part uuid;
begin
  select q.id into mid_req from public.requests q where q.series_id = series and q.series_index = 3;
  select jsonb_object_agg(id, jsonb_build_array(depart_at, return_at)) into times_before from public.requests where series_id = series;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  create temporary table sdc_before as select id from public.notifications where recipient_id = other;
  perform public.cancel_series_day(mid_ride, (select version from public.rides where id = mid_ride));
  set constraints all immediate;
  set constraints all deferred;

  assert (select status from public.rides where id = mid_ride) = 'cancelled', 'TEST 1 FAILED: the day''s ride is cancelled';
  assert (select status from public.requests where id = mid_req) in ('cancelled', 'withdrawn'), 'TEST 1 FAILED: the day''s request is gone';
  assert (select series_id from public.requests where id = mid_req) is null, 'TEST 1 FAILED: the day left the series';
  assert (select array_agg(series_index order by depart_at) from public.requests where series_id = series)::int[] = array[1, 2],
    'TEST 1 FAILED: days 1–2 stay one series';
  select series_id into after_part from public.requests
   where id::text in (select jsonb_object_keys(times_before)) and series_id is distinct from series and id <> mid_req limit 1;
  assert after_part is not null and (select count(*) from public.requests where series_id = after_part) = 2,
    'TEST 1 FAILED: days 4–5 are a series of their own';
  assert (select count(*) from public.rides r where r.series_id in (series, after_part) and r.status <> 'cancelled' and r.car_id = '00000000-0000-0000-0000-000000000041') = 4,
    'TEST 1 FAILED: the other four days keep their rides on the car';
  assert (select bool_and(jsonb_build_array(depart_at, return_at) = times_before -> id::text) from public.requests
          where id::text in (select jsonb_object_keys(times_before)) and id <> mid_req),
    'TEST 1 FAILED: every other day keeps its times';
  assert (select count(*) from public.notifications n where n.recipient_id = other and n.id not in (select id from sdc_before)) = 1,
    format('TEST 1 FAILED: the rider hears once, got %s', (select jsonb_agg(event) from public.notifications n where n.recipient_id = other and n.id not in (select id from sdc_before)));
  assert not exists (select 1 from public.notifications n where n.recipient_id = other and n.id not in (select id from sdc_before) and n.event = 'ride_edited'),
    'TEST 1 FAILED: no "ride edited" notice from the split';
  insert into sdc values ('after_part', after_part);
  raise notice 'TEST 1 passed: one middle day cancelled, the rest kept in two series, one notice';
end $$;

-- TEST 2
do $$
declare
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  after_part uuid := (select id from sdc where k = 'after_part');
  r1 uuid; q1 uuid; q2 uuid;
begin
  select q.id into q1 from public.requests q where q.series_id = after_part and q.series_index = 1;
  select q.id into q2 from public.requests q where q.series_id = after_part and q.series_index = 2;
  select rr.ride_id into r1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id where rr.request_id = q1 and r.status <> 'cancelled';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  perform public.cancel_series_day(r1, (select version from public.rides where id = r1), 'not needed', true, true);
  set constraints all immediate;
  set constraints all deferred;
  assert (select status from public.rides where id = r1) = 'cancelled', 'TEST 2 FAILED: the first day''s ride is cancelled';
  assert (select status_reason from public.requests where id = q1) = 'CLOSED_BY_SADRAN',
    format('TEST 2 FAILED: the day''s request is closed, got %s', (select row(status, status_reason) from public.requests where id = q1));
  assert (select series_id from public.requests where id = q2) is null and (select status from public.requests where id = q2) = 'assigned',
    'TEST 2 FAILED: the other day is an ordinary request, still placed';
  assert exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id where rr.request_id = q2 and r.status <> 'cancelled'),
    'TEST 2 FAILED: the other day keeps its ride';
  raise notice 'TEST 2 passed: the Sadran closes one day, the other stays';
end $$;

-- TEST 3
do $$
declare
  member uuid := '00000000-0000-0000-0000-000000000103';
  other uuid := '00000000-0000-0000-0000-000000000104';
  series uuid := (select id from sdc where k = 'series');
  r1 uuid; lone uuid;
begin
  select rr.ride_id into r1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id join public.requests q on q.id = rr.request_id
   where q.series_id = series and q.series_index = 1 and r.status <> 'cancelled';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  begin
    perform public.cancel_series_day(r1, (select version from public.rides where id = r1) + 5);
    raise exception 'TEST 3 FAILED: a stale version was accepted';
  exception when others then if sqlerrm not like '%stale%' then raise; end if; end;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', other, 'role', 'authenticated')::text, true);
  begin
    perform public.cancel_series_day(r1, (select version from public.rides where id = r1));
    raise exception 'TEST 3 FAILED: an unrelated member cancelled a day';
  exception when raise_exception then if sqlerrm <> 'not_authorized' then raise; end if; end;
  assert (select status from public.rides where id = r1) <> 'cancelled', 'TEST 3 FAILED: the refused cancel changed nothing';
  -- a ride with no series (the day left by TEST 2)
  select rr.ride_id into lone from public.ride_requests rr join public.rides r on r.id = rr.ride_id join public.requests q on q.id = rr.request_id
   where q.series_id is null and q.requester_id = member and r.status <> 'cancelled' and r.week_start = public.current_week_start() + 434 limit 1;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  begin
    perform public.cancel_series_day(lone, (select version from public.rides where id = lone));
    raise exception 'TEST 3 FAILED: a one-day ride went through the series path';
  exception when raise_exception then if sqlerrm <> 'series_split_invalid' then raise; end if; end;
  raise notice 'TEST 3 passed: refusals';
end $$;

rollback;
