-- SP1 (REQ item 228): split a multi-day ride into parts. Each part keeps the car, the rides and each day's times;
-- only the series links change; a one-day part is an ordinary request; one notice per person; refusals.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  member uuid := '00000000-0000-0000-0000-000000000103';
  other uuid := '00000000-0000-0000-0000-000000000104';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  car uuid := '00000000-0000-0000-0000-000000000041';
  w date := public.current_week_start() + 427;
  base jsonb; res jsonb; series uuid; head uuid; head_version int; n int; v_hist jsonb; part2 uuid; mid uuid;
  car_before uuid[]; times_before jsonb;
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
  select id into head from public.requests where series_id = series and series_index = 1;
  assert (select count(*) from public.requests where series_id = series) = 5, 'a five-day series';

  -- the Sadran places it on one car
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  perform public.place_series_on_car(series, car);
  assert (select count(*) from public.rides where series_id = series and status <> 'cancelled') >= 1, 'the series has rides';
  select array_agg(distinct car_id) into car_before from public.rides where series_id = series and status <> 'cancelled';
  select jsonb_object_agg(id, jsonb_build_array(depart_at, return_at)) into times_before from public.requests where series_id = series;

  -- (c) someone unrelated may not split it
  perform set_config('request.jwt.claims', jsonb_build_object('sub', other, 'role', 'authenticated')::text, true);
  select version into head_version from public.requests where id = head;
  begin
    perform public.split_series(head, array[2], head_version);
    raise exception 'an unrelated member split the series';
  exception when raise_exception then if sqlerrm <> 'not_authorized' then raise; end if; end;

  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  -- invalid cuts and a stale version are refused
  begin
    perform public.split_series(head, array[5], head_version);
    raise exception 'a cut after the last day was accepted';
  exception when raise_exception then if sqlerrm <> 'series_split_invalid' then raise; end if; end;
  begin
    perform public.split_series(head, array[2], head_version + 7);
    raise exception 'a stale split was accepted';
  exception when others then if sqlerrm not like '%stale%' then raise; end if; end;

  -- (a)/(b) 2 + 3: same car, same times, two series
  res := public.split_series(head, array[2], head_version);
  assert jsonb_array_length(res -> 'parts') = 2, format('two parts: %s', res);
  assert (select series_count from public.requests where id = head) = 2, 'the first part counts 2 days';
  part2 := (res -> 'parts' -> 1 ->> 'series_id')::uuid;
  assert part2 is not null and part2 <> series, 'the second part is a series of its own';
  assert (select array_agg(series_index order by depart_at) from public.requests where series_id = part2)::int[] = array[1, 2, 3],
    'the second part is numbered 1..3';
  assert (select count(*) from public.rides where series_id = part2 and status <> 'cancelled') >= 1, 'its rides moved with it';
  assert (select array_agg(distinct r.car_id) from public.rides r where r.series_id in (series, part2) and r.status <> 'cancelled') = car_before,
    'the car is kept';
  assert (select bool_and(jsonb_build_array(depart_at, return_at) = times_before -> id::text)
          from public.requests where id::text in (select jsonb_object_keys(times_before))),
    'every day keeps its own times';
  assert (select bool_and(status not in ('withdrawn', 'cancelled')) from public.requests where id::text in (select jsonb_object_keys(times_before))),
    'nothing withdrawn';

  -- (a) one per day on the second part: three ordinary requests
  select id, version into mid, head_version from public.requests where series_id = part2 and series_index = 1;
  res := public.split_series(mid, array[1, 2], head_version);
  assert jsonb_array_length(res -> 'parts') = 3, 'three one-day parts';
  assert (select count(*) from public.requests where id::text in (select jsonb_object_keys(times_before)) and series_id is null) = 3,
    'one-day parts are ordinary requests';

  -- (f) history
  v_hist := public.request_history(mid);
  assert exists (select 1 from jsonb_array_elements(v_hist) e where e ->> 'kind' = 'split'), format('history shows the split: %s', v_hist);

  -- (d) the member split it themself: no notice to the member
  select count(*) into n from public.notifications where recipient_id = member and data ->> 'variant' = 'series_split';
  assert n = 0, 'no notice for one''s own split';

  -- (c) a single-day request is not a series
  begin
    perform public.split_series(mid, array[1], (select version from public.requests where id = mid));
    raise exception 'a single day was split';
  exception when raise_exception then if sqlerrm <> 'request_not_found' then raise; end if; end;

  -- (d) the Sadran splits the first part: the member is told once
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  perform public.split_series(head, array[1], (select version from public.requests where id = head));
  select count(*) into n from public.notifications where recipient_id = member and data ->> 'variant' = 'series_split';
  assert n = 1, format('the member gets one notice, got %s', n);

  raise notice 'split_series.sql: all assertions passed';
end $$;

rollback;
