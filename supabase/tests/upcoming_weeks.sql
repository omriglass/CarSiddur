-- `upcoming` week phase (REQ §13.77, DATA_MODEL §2/§3.5/§5.9). Transactional: every fixture
-- row is rolled back at the end. Uses the seeded נבו department (…0001, home …0010),
-- Sadran …0102, member …0103, car …0040, destination חיפה …0011, ride type …0021, on a
-- far-future week so nothing collides with the demo data or the other suites.
begin;

-- (a) a series reaching a week with no `weeks` row materializes it as `upcoming` instead of
-- refusing the whole booking; (b) an ordinary (non-series) request against that same
-- upcoming week is refused with `week_not_open`; (d) it is never publicly visible even
-- though the Sadran can still manage it (board access to see the pinned leg); a solved leg
-- in the still-open week drags the upcoming week's leg along as a pinned carry-over ride
-- while it is still `upcoming`; (c) materialize_department_weeks()/advance_week_phases()
-- promote the week to `open` exactly at its normal opening time and fire `window_open`
-- exactly once; (e) the pinned carry-over ride survives both the promotion and a later
-- full solve of the now-open week.
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  member uuid := '00000000-0000-0000-0000-000000000103';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  home uuid := '00000000-0000-0000-0000-000000000010';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  car uuid := '00000000-0000-0000-0000-000000000040';
  w date := public.current_week_start() + 371;
  next_open_at timestamptz;
  result jsonb; s1 uuid; before_n int; after_n int; carry record;
  payload_rides jsonb := '[]'::jsonb; leg record;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
    values (dept, w, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');

  -- (a)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  result := public.submit_series_request(jsonb_build_object(
    'department_id', dept, 'week_start', w, 'destination_id', dest, 'ride_type_id', ride_type,
    'trip_shape', 'round_trip', 'adults', 1,
    'depart_at', ((w + 6) + time '09:00') at time zone 'Asia/Jerusalem',
    'return_at', ((w + 7) + time '17:00') at time zone 'Asia/Jerusalem'));
  s1 := (result ->> 'series_id')::uuid;
  assert jsonb_array_length(result -> 'request_ids') = 2, 'the span did not produce both legs';
  assert (select phase from public.weeks where department_id = dept and week_start = w + 7) = 'upcoming',
    'the unopened next week was not materialized as upcoming';
  assert (select count(*) = 1 from public.requests where series_id = s1 and week_start = w + 7),
    'the second leg was not filed against the upcoming week';
  select open_at into next_open_at from public.weeks where department_id = dept and week_start = w + 7;

  -- (d)
  assert not public.is_week_public(dept, w + 7), 'an upcoming week reported as publicly visible';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  assert public.can_manage_week(dept, w + 7), 'the Sadran cannot manage the upcoming week to see its pinned leg';

  -- (b)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  begin
    perform public.submit_request(jsonb_build_object('department_id', dept, 'week_start', w + 7,
      'destination_id', dest, 'ride_type_id', ride_type, 'trip_shape', 'round_trip', 'adults', 1,
      'depart_at', ((w + 8) + time '09:00') at time zone 'Asia/Jerusalem',
      'return_at', ((w + 8) + time '17:00') at time zone 'Asia/Jerusalem'));
    raise exception 'an ordinary request into an upcoming week was accepted';
  exception when others then
    if sqlerrm <> 'week_not_open' then raise; end if;
  end;

  -- publish_siddur()/publication_readiness() must never be reachable for it either.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  begin
    perform public.publication_readiness(dept, w + 7);
    raise exception 'publication_readiness accepted an upcoming week';
  exception when others then
    if sqlerrm <> 'week_not_open' then raise; end if;
  end;

  -- The still-open week's leg is solved onto a car; place_series() drags the upcoming
  -- week's leg along as a pinned SERIES_CARRY_OVER ride while that week is still upcoming.
  select q.* into leg from public.requests q where q.series_id = s1 and q.week_start = w;
  payload_rides := jsonb_build_array(jsonb_build_object(
    'car_id', car, 'starts_at', leg.depart_at, 'ends_at', leg.return_at,
    'origin_id', home, 'destination_id', dest, 'driver_id', leg.requester_id,
    'served', jsonb_build_array(jsonb_build_object('request_id', leg.id, 'role', 'driver',
      'leg', 'both', 'car_mode', 'keep'))));
  perform public.apply_solver_result(dept, w, jsonb_build_object('mode', 'full',
    'rides', payload_rides, 'request_statuses', '[]'::jsonb,
    'policy_version_id', '00000000-0000-0000-0000-000000000031', 'input_hash', 'upcoming-carry-over',
    'solver_version', 'test', 'started_at', now()::text, 'finished_at', now()::text, 'duration_ms', 0,
    'summary', '{}'::jsonb));

  select count(*) as n, bool_and(is_pinned) as pinned, min(pin_reason) as reason,
    min(status::text) as status
  into carry from public.rides where series_id = s1 and week_start = w + 7 and status <> 'cancelled';
  assert carry.n = 1 and carry.pinned and carry.reason = 'SERIES_CARRY_OVER',
    'the upcoming week leg was not materialized as a pinned SERIES_CARRY_OVER ride';
  assert carry.status = 'draft', 'a carry-over ride into an upcoming (non-public) week was not draft';
  assert (select phase from public.weeks where department_id = dept and week_start = w + 7) = 'upcoming',
    'placing a ride in the next week promoted its phase early';

  -- (c) no window_open yet, and none before the week's own opening time.
  select count(*) into before_n from public.notifications
    where department_id = dept and week_start = w + 7 and event = 'window_open';
  assert before_n = 0, 'window_open fired before the upcoming week opened';

  perform public.advance_week_phases(next_open_at - interval '1 hour');
  assert (select phase from public.weeks where department_id = dept and week_start = w + 7) = 'upcoming',
    'the week opened before its own open_at';

  perform public.advance_week_phases(next_open_at + interval '1 hour');
  assert (select phase from public.weeks where department_id = dept and week_start = w + 7) = 'open',
    'advance_week_phases did not promote the upcoming week at its opening time';
  assert not public.is_week_public(dept, w + 7), 'a freshly opened (not yet published) week reported as publicly visible';

  select count(*) into after_n from public.notifications
    where department_id = dept and week_start = w + 7 and event = 'window_open';
  assert after_n > before_n, 'window_open did not fire on the upcoming -> open transition';

  -- Idempotent: a later tick at the same or a later moment does not refire it.
  perform public.advance_week_phases(next_open_at + interval '2 hours');
  assert (select count(*) from public.notifications
    where department_id = dept and week_start = w + 7 and event = 'window_open') = after_n,
    'window_open fired again for an already-open week';

  -- (e) the pinned carry-over ride survived the promotion; it also survives a later full
  -- solve of the now-open week (is_pinned rows are never touched by the delete-drafts step).
  assert (select count(*) = 1 from public.rides
    where series_id = s1 and week_start = w + 7 and status <> 'cancelled' and is_pinned),
    'the carry-over ride did not survive the upcoming -> open promotion';

  perform public.apply_solver_result(dept, w + 7, jsonb_build_object('mode', 'full',
    'rides', '[]'::jsonb, 'request_statuses', '[]'::jsonb,
    'policy_version_id', '00000000-0000-0000-0000-000000000031', 'input_hash', 'upcoming-full-solve',
    'solver_version', 'test', 'started_at', now()::text, 'finished_at', now()::text, 'duration_ms', 0,
    'summary', '{}'::jsonb));
  assert (select count(*) = 1 from public.rides
    where series_id = s1 and week_start = w + 7 and status <> 'cancelled'),
    'a full solve of the newly-opened week deleted the carry-over leg';
end $$;

-- MDR01 stays for the genuinely impossible cases: a leg before the real current week, or
-- more than 6 weeks past the series' own first leg (independent of wall-clock "today", so a
-- series legitimately anchored on a far-future open week for test isolation is unaffected).
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  member uuid := '00000000-0000-0000-0000-000000000103';
  dest uuid := '00000000-0000-0000-0000-000000000011';
  ride_type uuid := '00000000-0000-0000-0000-000000000021';
  w date := public.current_week_start() + 371;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);

  begin
    perform public.submit_series_request(jsonb_build_object(
      'department_id', dept, 'week_start', w, 'destination_id', dest, 'ride_type_id', ride_type,
      'trip_shape', 'round_trip', 'adults', 1,
      'depart_at', ((public.current_week_start() - 7) + time '09:00') at time zone 'Asia/Jerusalem',
      'return_at', ((public.current_week_start() - 6) + time '17:00') at time zone 'Asia/Jerusalem'));
    raise exception 'a span landing before the current week was accepted';
  exception when sqlstate 'MDR01' then null; end;

  begin
    perform public.submit_series_request(jsonb_build_object(
      'department_id', dept, 'week_start', w, 'destination_id', dest, 'ride_type_id', ride_type,
      'trip_shape', 'round_trip', 'adults', 1,
      'depart_at', (w + time '09:00') at time zone 'Asia/Jerusalem',
      'return_at', ((w + 50) + time '17:00') at time zone 'Asia/Jerusalem'));
    raise exception 'a span more than 6 weeks past its own first leg was accepted';
  exception when sqlstate 'MDR01' then null; end;
end $$;

rollback;
