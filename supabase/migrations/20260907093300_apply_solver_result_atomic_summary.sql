-- MAJOR BUG follow-up (docs/UX_FLOWS.md §19 "Solve/apply semantics after
-- owner testing"): owner report after the previous fix pass (mode
-- 'full'/'remaining', 20260907093100_apply_solver_result_remaining_mode.sql)
-- was "clicking Solve and Autofill STILL sometimes makes certain rides
-- disappear." Reproduced directly against the local stack: Solve → Apply,
-- then Solve → Apply again with *no changes in between* ("full" mode both
-- times, the dashboard's "הרץ פותר") makes every ride the first solve
-- placed vanish on the second apply, while the requests they served stay
-- stuck at `assigned`/`merged` with no ride at all.
--
-- Root cause was entirely client-side (`src/features/sadran/applySolve.ts`,
-- formerly `solverRun.ts`'s `gatherSolverContext`): which requests were fed
-- to `solve()` was decided by *request status* (`submitted`/`waitlisted`
-- only), independently of which rides were passed as `fixedRides` (decided
-- by `is_pinned`). A request already `assigned`/`merged` by a *previous
-- solve's own unpinned ride* was neither open (wrong status) nor fixed (its
-- ride isn't pinned) — invisible to the solver, so `solve()`'s output never
-- mentioned it, yet `apply_solver_result`'s `'full'` mode still deleted its
-- unpinned ride (correct per SOLVER.md §5.1 in isolation) without ever
-- being asked to replace it. See `applySolve.ts`'s header comment for the
-- full analysis and the client-side fix (a request is now reopened whenever
-- its *current ride is not fixed*, regardless of status).
--
-- This migration does not change that RPC-side delete/insert logic (it was
-- already correct given a complete payload — 20260907093100 already fixed
-- 'remaining' mode's over-eager delete). It adds the two DB-side pieces the
-- investigation's required outcome calls for, so a client-side regression
-- like this one is caught immediately instead of silently:
--
-- 1. `apply_solver_result` now returns a structured summary jsonb
--    `{ run_id, inserted, deleted, unchanged, unassigned_requests }` instead
--    of a bare uuid, so the UI can show exactly what happened (never a
--    silent partial result) and `supabase/tests/solve_semantics.sql` can
--    assert on it directly. The function was already atomic (a single
--    PL/pgSQL function invocation is one implicit transaction; any raised
--    exception — including `assert_car_chain`'s — unwinds every insert/
--    delete/update this call made, so there is no partial-apply case to
--    additionally guard against here).
-- 2. `assert_car_chain` now names the car and the offending ride's window
--    in its exception `detail` (previously just ride/location uuids) so
--    `src/lib/rpc.ts` can surface a Hebrew toast that actually identifies
--    which ride broke, per the investigation's "never silently partial, and
--    never anonymous" requirement.

create or replace function public.assert_car_chain(_car uuid, _week date) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_home uuid; v_day_end time; v_loc uuid; v_car_name text; r record;
begin
  select d.home_destination_id, s.day_end_time, c.name into v_home, v_day_end, v_car_name
  from public.cars c
  join public.departments d on d.id = c.department_id
  join public.department_settings s on s.department_id = d.id
  where c.id = _car;
  if v_home is null then raise exception 'no_home_location' using errcode = 'P0412'; end if;

  v_loc := v_home;                                   -- v1: every car starts the week at home
  for r in
    select id, origin_id, destination_id, starts_at, ends_at, overnight_ack_by
    from public.rides
    where car_id = _car and week_start = _week and status <> 'cancelled'
    order by starts_at
  loop
    if r.origin_id <> v_loc then
      raise exception 'car_chain_broken' using errcode = 'P0410',
        detail = format('%s %s–%s', v_car_name,
          to_char(r.starts_at at time zone 'Asia/Jerusalem', 'DD/MM HH24:MI'),
          to_char(r.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI'));
    end if;
    v_loc := r.destination_id;

    if r.destination_id <> v_home and r.overnight_ack_by is null then
      if not exists (
        select 1 from public.rides n
        where n.car_id = _car and n.status <> 'cancelled' and n.starts_at > r.ends_at
          and n.starts_at < (((r.ends_at at time zone 'Asia/Jerusalem')::date + v_day_end) at time zone 'Asia/Jerusalem')
      ) then
        raise exception 'car_away_at_day_end' using errcode = 'P0411',
          detail = format('%s %s–%s', v_car_name,
            to_char(r.starts_at at time zone 'Asia/Jerusalem', 'DD/MM HH24:MI'),
            to_char(r.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI'));
      end if;
    end if;
  end loop;
end $$;

revoke execute on function public.assert_car_chain(uuid, date) from public, anon;
grant execute on function public.assert_car_chain(uuid, date) to authenticated;

-- apply_solver_result's return type changes (uuid -> jsonb), which Postgres
-- requires a drop + recreate for (CREATE OR REPLACE cannot change the
-- return type). No other function calls it, so this is safe.
drop function if exists public.apply_solver_result(uuid, date, jsonb);

create function public.apply_solver_result(p_department_id uuid, p_week_start date, p_payload jsonb) returns jsonb
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_run_id uuid;
  v_ride jsonb;
  v_served jsonb;
  v_ride_id uuid;
  v_status jsonb;
  v_touched_cars uuid[] := '{}';
  v_input_hash text := p_payload ->> 'input_hash';
  v_preview record;
  v_preview_found boolean := false;
  v_current_fingerprint text;
  v_mode text := coalesce(p_payload ->> 'mode', 'full');
  v_existing_count int;
  v_deleted int := 0;
  v_inserted int := 0;
  v_unassigned uuid[] := '{}';
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'apply_solver_result', true);

  if v_input_hash is not null then
    select * into v_preview from public.solver_runs
    where department_id = p_department_id and week_start = p_week_start
      and input_hash = v_input_hash and applied = false
    order by started_at desc limit 1;
    v_preview_found := found;

    if v_preview_found and v_preview.state_fingerprint is not null then
      v_current_fingerprint := public.week_state_fingerprint(p_department_id, p_week_start);
      if v_current_fingerprint <> v_preview.state_fingerprint then
        raise exception 'stale_input' using errcode = 'P0409';
      end if;
    end if;
  end if;

  select count(*) into v_existing_count
  from public.rides where department_id = p_department_id and week_start = p_week_start and status <> 'cancelled';

  insert into public.solver_runs (department_id, week_start, policy_version_id, input_hash, solver_version,
    status, started_at, finished_at, duration_ms, ran_by, applied, summary, state_fingerprint)
  values (p_department_id, p_week_start, (p_payload ->> 'policy_version_id')::uuid, p_payload ->> 'input_hash',
    p_payload ->> 'solver_version', 'succeeded', (p_payload ->> 'started_at')::timestamptz,
    (p_payload ->> 'finished_at')::timestamptz, (p_payload ->> 'duration_ms')::int,
    (select auth.uid()), true, coalesce(p_payload -> 'summary', '{}'),
    public.week_state_fingerprint(p_department_id, p_week_start))
  returning id into v_run_id;

  if v_preview_found then
    update public.solver_runs set applied = true where id = v_preview.id;
  end if;

  -- "remaining" mode (bug #5): every current ride was already a fixed
  -- constraint the solver never re-solved, so it must never be deleted here
  -- — this payload's `rides` only ever adds newly-solved assignments for
  -- requests that had no ride at all. "full" mode keeps replacing every
  -- non-pinned draft (the solver's own re-solved output supersedes them).
  if v_mode = 'full' then
    delete from public.rides
    where department_id = p_department_id and week_start = p_week_start and status = 'draft' and not is_pinned;
    get diagnostics v_deleted = row_count;
  end if;

  for v_ride in select * from jsonb_array_elements(coalesce(p_payload -> 'rides', '[]'))
  loop
    insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
      driver_id, status, is_pinned, pin_reason, created_by_solver_run_id, created_by, overflow_allowed)
    values (p_department_id, p_week_start, (v_ride ->> 'car_id')::uuid,
      (v_ride ->> 'starts_at')::timestamptz, (v_ride ->> 'ends_at')::timestamptz,
      (v_ride ->> 'origin_id')::uuid, (v_ride ->> 'destination_id')::uuid,
      (v_ride ->> 'driver_id')::uuid, 'draft',
      coalesce((v_ride ->> 'is_pinned')::boolean, false), v_ride ->> 'pin_reason',
      v_run_id, (select auth.uid()), coalesce((v_ride ->> 'overflow_allowed')::boolean, false))
    returning id into v_ride_id;

    v_inserted := v_inserted + 1;
    v_touched_cars := array_append(v_touched_cars, (v_ride ->> 'car_id')::uuid);

    for v_served in select * from jsonb_array_elements(coalesce(v_ride -> 'served', '[]'))
    loop
      insert into public.ride_requests (ride_id, request_id, role, leg, car_mode, detour_minutes)
      values (v_ride_id, (v_served ->> 'request_id')::uuid, (v_served ->> 'role')::public.ride_role,
        coalesce((v_served ->> 'leg')::public.ride_leg, 'both'), (v_served ->> 'car_mode')::public.leg_car_mode,
        coalesce((v_served ->> 'detour_minutes')::smallint, 0));
    end loop;
  end loop;

  for v_status in select * from jsonb_array_elements(coalesce(p_payload -> 'request_statuses', '[]'))
  loop
    update public.requests
    set status = (v_status ->> 'status')::public.request_status,
        status_reason = v_status ->> 'status_reason',
        changed_since_solve = false
    where id = (v_status ->> 'request_id')::uuid;

    if (v_status ->> 'status') = 'waitlisted' then
      v_unassigned := array_append(v_unassigned, (v_status ->> 'request_id')::uuid);
    end if;
  end loop;

  -- Any failure here (a broken car chain, a car away at day end without
  -- acknowledgement, …) raises and unwinds every insert/delete/update this
  -- call made above — apply_solver_result is one PL/pgSQL function
  -- invocation, hence one implicit transaction; there is no partial-apply
  -- outcome, only "fully applied" or "fully rolled back, error surfaced".
  perform public.assert_car_chain(car_id, p_week_start) from unnest(v_touched_cars) as car_id;

  return jsonb_build_object(
    'run_id', v_run_id,
    'inserted', v_inserted,
    'deleted', v_deleted,
    'unchanged', greatest(v_existing_count - v_deleted, 0),
    'unassigned_requests', coalesce(to_jsonb(v_unassigned), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.apply_solver_result(uuid, date, jsonb) from public, anon;
grant execute on function public.apply_solver_result(uuid, date, jsonb) to authenticated;
