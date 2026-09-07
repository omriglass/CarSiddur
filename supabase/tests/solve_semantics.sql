-- DB invariant tests for `apply_solver_result` (MAJOR BUG investigation,
-- docs/UX_FLOWS.md §19, docs/DATA_MODEL.md §6.1 item 25). Run against the
-- local stack with:
--   npm run db:test
-- (wired alongside supabase/tests/rls_smoke.sql). Everything runs inside one
-- transaction rolled back at the end, so this is safe to run repeatedly
-- against a seeded local database without leaving fixture rows behind.
--
-- Assumes `supabase/seed.sql` has been applied: department "נבו"
-- (00000000-0000-0000-0000-000000000001, home destination ...0010), sadran
-- profile ...0102 (standing assignment, any week), member1 ...0103, member2
-- ...0104, cars ...0040/...0041/...0042 (shared), ride type "work" ...0021,
-- destination "חיפה" ...0011.
--
-- These tests call `apply_solver_result` directly with hand-built payloads
-- (bypassing the actual `solve()` run) so they exercise the RPC's own
-- invariants in isolation from the client-side bug this investigation fixed
-- (`src/features/sadran/applySolve.ts`'s `selectOpenRequests` — covered
-- instead by `applySolve.test.ts`, a Vitest unit test, since the bug was
-- entirely in which requests the *client* fed to `solve()`, not in this RPC).
--
-- Fixture rows (requests/rides/ride_requests) are inserted directly as the
-- superuser (no INSERT policy exists on these tables at all —
-- `submit_request()`/`edit_ride()` are the only write paths per
-- rls_smoke.sql TEST 2/TEST 2), then the role switches to `authenticated`
-- with the sadran's `sub` claim only around the actual `apply_solver_result`
-- call and its assertions, mirroring rls_smoke.sql's own convention.

begin;

do $$
declare
  v_week date;
begin
  foreach v_week in array array[
    public.current_week_start() + 14,
    public.current_week_start() + 21,
    public.current_week_start() + 28
  ] loop
    insert into public.weeks (department_id, week_start, phase, open_at, close_at, publish_at)
    values ('00000000-0000-0000-0000-000000000001', v_week, 'solving',
      v_week - interval '7 days', v_week - interval '5 days', v_week - interval '4 days')
    on conflict (department_id, week_start) do nothing;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- TEST 1: 'remaining' mode never decreases ride count nor changes any
-- existing ride row (owner bug report, §19: "auto-solve remaining"/the
-- primary Solve action must never delete or alter what's already there);
-- and the request it served (assigned) is still assigned afterward — the
-- exact regression the owner reported.
-- ---------------------------------------------------------------------------
do $$
declare
  v_week date := public.current_week_start() + 14;
  v_req_a uuid;
  v_ride_a uuid;
begin
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status, status_reason)
  values ('00000000-0000-0000-0000-000000000001', v_week, '00000000-0000-0000-0000-000000000103',
    '00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021',
    'round_trip', v_week + interval '1 day 8 hours', v_week + interval '1 day 12 hours', 1, now(), 'assigned', 'SADRAN_ASSIGNED')
  returning id into v_req_a;

  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, is_pinned, created_by)
  values ('00000000-0000-0000-0000-000000000001', v_week, '00000000-0000-0000-0000-000000000040',
    v_week + interval '1 day 8 hours', v_week + interval '1 day 12 hours',
    '00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000103', 'draft', false, '00000000-0000-0000-0000-000000000102')
  returning id into v_ride_a;

  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
  values (v_ride_a, v_req_a, 'driver', 'both', 'keep');
end $$;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}', true);

do $$
declare
  v_week date := public.current_week_start() + 14;
  v_before_count int;
  v_after_count int;
  v_ride_after record;
  v_result jsonb;
begin
  select count(*) into v_before_count from public.rides
  where department_id = '00000000-0000-0000-0000-000000000001' and week_start = v_week and status <> 'cancelled';

  -- Simulate "solve remaining" finding nothing new to place (Solve -> Apply,
  -- then Solve -> Apply again with no changes, sequence (a) of the
  -- investigation): an empty payload in 'remaining' mode.
  v_result := public.apply_solver_result('00000000-0000-0000-0000-000000000001', v_week,
    jsonb_build_object('mode', 'remaining', 'rides', '[]'::jsonb, 'request_statuses', '[]'::jsonb,
      'policy_version_id', '00000000-0000-0000-0000-000000000031', 'input_hash', 'test-hash-1',
      'solver_version', 'test', 'started_at', now()::text, 'finished_at', now()::text, 'duration_ms', 0,
      'summary', '{}'::jsonb));

  select count(*) into v_after_count from public.rides
  where department_id = '00000000-0000-0000-0000-000000000001' and week_start = v_week and status <> 'cancelled';
  assert v_after_count >= v_before_count,
    format('TEST 1 FAILED: remaining mode decreased ride count from %s to %s', v_before_count, v_after_count);
  assert v_after_count = v_before_count,
    format('TEST 1 FAILED: remaining mode with an empty payload must not change ride count, was %s now %s', v_before_count, v_after_count);

  assert (v_result ->> 'deleted')::int = 0, 'TEST 1 FAILED: remaining mode summary must report deleted = 0';

  raise notice 'TEST 1 PASSED: remaining mode with an empty payload never decreases ride count';
end $$;

reset role;

do $$
declare
  v_week date := public.current_week_start() + 14;
  v_req_a uuid;
  v_ride_a record;
begin
  select id into v_req_a from public.requests
  where department_id = '00000000-0000-0000-0000-000000000001' and week_start = v_week
    and depart_at = v_week + interval '1 day 8 hours';

  select * into v_ride_a from public.rides
  where department_id = '00000000-0000-0000-0000-000000000001' and week_start = v_week
    and starts_at = v_week + interval '1 day 8 hours' and car_id = '00000000-0000-0000-0000-000000000040';

  assert v_ride_a.status <> 'cancelled', 'TEST 1 FAILED: remaining mode removed the existing ride row';
  assert v_ride_a.car_id = '00000000-0000-0000-0000-000000000040',
    'TEST 1 FAILED: remaining mode changed an existing ride''s car';

  -- THE core regression this investigation was filed over: the request that
  -- was `assigned` before the (no-op) remaining-mode apply must still be
  -- `assigned` afterward, with its ride intact.
  assert (select status from public.requests where id = v_req_a) = 'assigned',
    'TEST 1 FAILED: a request assigned before a remaining-mode apply must remain assigned after one';

  raise notice 'TEST 1 PASSED: remaining mode with an empty payload changes no existing ride row and no assigned request''s status';
end $$;

-- ---------------------------------------------------------------------------
-- TEST 2: 'full' mode never deletes a pinned ride, and correctly removes an
-- unpinned (solver-made) one while marking its now-unserved request
-- waitlisted (never leaving it dangling with no ride at all).
-- ---------------------------------------------------------------------------
do $$
declare
  v_week date := public.current_week_start() + 21;
  v_req_pinned uuid;
  v_req_unpinned uuid;
  v_ride_pinned uuid;
  v_ride_unpinned uuid;
begin
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status, status_reason)
  values
    ('00000000-0000-0000-0000-000000000001', v_week, '00000000-0000-0000-0000-000000000103',
     '00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021',
     'round_trip', v_week + interval '2 days 8 hours', v_week + interval '2 days 12 hours', 1, now(), 'assigned', 'SADRAN_EDIT')
    returning id into v_req_pinned;

  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status, status_reason)
  values
    ('00000000-0000-0000-0000-000000000001', v_week, '00000000-0000-0000-0000-000000000103',
     '00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021',
     'round_trip', v_week + interval '2 days 14 hours', v_week + interval '2 days 18 hours', 1, now(), 'assigned', 'SADRAN_ASSIGNED')
    returning id into v_req_unpinned;

  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, is_pinned, pin_reason, created_by)
  values ('00000000-0000-0000-0000-000000000001', v_week, '00000000-0000-0000-0000-000000000040',
    v_week + interval '2 days 8 hours', v_week + interval '2 days 12 hours',
    '00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000103', 'draft', true, 'SADRAN_MANUAL', '00000000-0000-0000-0000-000000000102')
  returning id into v_ride_pinned;
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode) values (v_ride_pinned, v_req_pinned, 'driver', 'both', 'keep');

  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, is_pinned, created_by)
  values ('00000000-0000-0000-0000-000000000001', v_week, '00000000-0000-0000-0000-000000000041',
    v_week + interval '2 days 14 hours', v_week + interval '2 days 18 hours',
    '00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000103', 'draft', false, '00000000-0000-0000-0000-000000000102')
  returning id into v_ride_unpinned;
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode) values (v_ride_unpinned, v_req_unpinned, 'driver', 'both', 'keep');
end $$;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}', true);

do $$
declare
  v_week date := public.current_week_start() + 21;
  v_req_unpinned uuid;
  v_result jsonb;
begin
  select id into v_req_unpinned from public.requests
  where department_id = '00000000-0000-0000-0000-000000000001' and week_start = v_week
    and depart_at = v_week + interval '2 days 14 hours';

  -- A 'full' re-solve whose own solve() found nowhere to place v_req_unpinned
  -- (its ride is not fixed, so a fixed client correctly reopens it, per
  -- SOLVER.md §5.3) — an empty `rides` array, and the request explicitly
  -- marked waitlisted, never left silently dangling.
  v_result := public.apply_solver_result('00000000-0000-0000-0000-000000000001', v_week,
    jsonb_build_object('mode', 'full', 'rides', '[]'::jsonb,
      'request_statuses', jsonb_build_array(
        jsonb_build_object('request_id', v_req_unpinned, 'status', 'waitlisted', 'status_reason', 'WAITLISTED_NO_CAR')),
      'policy_version_id', '00000000-0000-0000-0000-000000000031', 'input_hash', 'test-hash-2',
      'solver_version', 'test', 'started_at', now()::text, 'finished_at', now()::text, 'duration_ms', 0,
      'summary', '{}'::jsonb));

  assert (v_result ->> 'deleted')::int = 1, format('TEST 2 FAILED: expected deleted=1, got %s', v_result ->> 'deleted');
  assert (v_result -> 'unassigned_requests') @> to_jsonb(array[v_req_unpinned]),
    'TEST 2 FAILED: unassigned_requests summary must list the request that lost its assignment';

  raise notice 'TEST 2 PASSED: full-mode apply_solver_result summary reports the delete and the newly-unassigned request';
end $$;

reset role;

do $$
declare
  v_week date := public.current_week_start() + 21;
  v_req_pinned uuid;
  v_req_unpinned uuid;
  v_ride_pinned uuid;
  v_ride_unpinned uuid;
begin
  select id into v_req_pinned from public.requests
  where department_id = '00000000-0000-0000-0000-000000000001' and week_start = v_week
    and depart_at = v_week + interval '2 days 8 hours';
  select id into v_req_unpinned from public.requests
  where department_id = '00000000-0000-0000-0000-000000000001' and week_start = v_week
    and depart_at = v_week + interval '2 days 14 hours';
  select id into v_ride_pinned from public.rides
  where department_id = '00000000-0000-0000-0000-000000000001' and week_start = v_week and is_pinned;
  select id into v_ride_unpinned from public.rides
  where department_id = '00000000-0000-0000-0000-000000000001' and week_start = v_week
    and car_id = '00000000-0000-0000-0000-000000000041';

  assert v_ride_pinned is not null and exists (select 1 from public.rides where id = v_ride_pinned and status <> 'cancelled'),
    'TEST 2 FAILED: full mode must never delete a pinned ride';
  assert v_ride_unpinned is null,
    'TEST 2 FAILED: full mode must delete a non-pinned (solver-made) ride when the new solve does not recreate it';

  assert (select status from public.requests where id = v_req_pinned) = 'assigned',
    'TEST 2 FAILED: the pinned ride''s request status must be untouched by an unrelated full-mode apply';
  assert (select status from public.requests where id = v_req_unpinned) = 'waitlisted',
    'TEST 2 FAILED: a request whose only ride was deleted must end up waitlisted, never left assigned with no ride';

  raise notice 'TEST 2 PASSED: full mode never deletes a pinned ride, and never leaves an unserved request assigned';
end $$;

-- ---------------------------------------------------------------------------
-- TEST 3: a request `merged` (passenger role) before a remaining-mode apply
-- stays `merged` afterward too — not only the driver/`assigned` case tested
-- above (the reopenable-statuses set in applySolve.ts covers both).
-- ---------------------------------------------------------------------------
do $$
declare
  v_week date := public.current_week_start() + 28;
  v_req_driver uuid;
  v_req_passenger uuid;
  v_ride uuid;
begin
  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status, status_reason)
  values
    ('00000000-0000-0000-0000-000000000001', v_week, '00000000-0000-0000-0000-000000000103',
     '00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021',
     'round_trip', v_week + interval '3 days 8 hours', v_week + interval '3 days 12 hours', 1, now(), 'assigned', 'SADRAN_ASSIGNED')
    returning id into v_req_driver;

  insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status, status_reason)
  values
    ('00000000-0000-0000-0000-000000000001', v_week, '00000000-0000-0000-0000-000000000104',
     '00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021',
     'round_trip', v_week + interval '3 days 8 hours', v_week + interval '3 days 12 hours', 1, now(), 'merged', 'SADRAN_ASSIGNED')
    returning id into v_req_passenger;

  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, is_pinned, created_by)
  values ('00000000-0000-0000-0000-000000000001', v_week, '00000000-0000-0000-0000-000000000042',
    v_week + interval '3 days 8 hours', v_week + interval '3 days 12 hours',
    '00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000103', 'draft', false, '00000000-0000-0000-0000-000000000102')
  returning id into v_ride;
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode) values (v_ride, v_req_driver, 'driver', 'both', 'keep');
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode) values (v_ride, v_req_passenger, 'passenger', 'both', 'passenger');
end $$;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}', true);

do $$
declare
  v_week date := public.current_week_start() + 28;
begin
  perform public.apply_solver_result('00000000-0000-0000-0000-000000000001', v_week,
    jsonb_build_object('mode', 'remaining', 'rides', '[]'::jsonb, 'request_statuses', '[]'::jsonb,
    'policy_version_id', '00000000-0000-0000-0000-000000000031', 'input_hash', 'test-hash-3',
    'solver_version', 'test', 'started_at', now()::text, 'finished_at', now()::text, 'duration_ms', 0,
    'summary', '{}'::jsonb));
end $$;

reset role;

do $$
declare
  v_week date := public.current_week_start() + 28;
  v_req_driver uuid;
  v_req_passenger uuid;
  v_ride uuid;
begin
  select id into v_req_driver from public.requests
  where department_id = '00000000-0000-0000-0000-000000000001' and week_start = v_week
    and requester_id = '00000000-0000-0000-0000-000000000103' and depart_at = v_week + interval '3 days 8 hours';
  select id into v_req_passenger from public.requests
  where department_id = '00000000-0000-0000-0000-000000000001' and week_start = v_week
    and requester_id = '00000000-0000-0000-0000-000000000104' and depart_at = v_week + interval '3 days 8 hours';
  select id into v_ride from public.rides
  where department_id = '00000000-0000-0000-0000-000000000001' and week_start = v_week
    and car_id = '00000000-0000-0000-0000-000000000042';

  assert v_ride is not null and exists (select 1 from public.rides where id = v_ride and status <> 'cancelled'),
    'TEST 3 FAILED: remaining mode must not delete the merged ride';
  assert (select status from public.requests where id = v_req_driver) = 'assigned',
    'TEST 3 FAILED: driver request must remain assigned';
  assert (select status from public.requests where id = v_req_passenger) = 'merged',
    'TEST 3 FAILED: passenger request must remain merged (not silently waitlisted/unassigned)';

  raise notice 'TEST 3 PASSED: a merged (passenger) request survives an empty remaining-mode apply, same as an assigned (driver) one';
end $$;

rollback;
