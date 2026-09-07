-- Bug-fix pass after Sadran owner testing, bug #5 (docs/UX_FLOWS.md §17,
-- DATA_MODEL.md §6.1): `apply_solver_result` unconditionally deleted every
-- `status = 'draft' and not is_pinned` ride of the week before inserting the
-- payload's own rides — correct for a normal full re-solve (SOLVER.md §5.1:
-- "a full re-solve may replace unpinned solver-made rides"), but "▶ השלם
-- אוטומטית" ("auto-solve remaining", `BoardScreen.tsx`'s
-- `handleAutoSolveRemaining`) passes every existing ride to the solver as a
-- `fixedRide` constraint (`gatherSolverContext({ mode: 'remaining' })`) —
-- the solver never re-considers them, so its own output payload never lists
-- them again, and this RPC then deleted them anyway. Reproduced directly
-- against the local stack: apply a first solve, run "auto-solve remaining"
-- with nothing new to place, and every previously-placed ride vanished (its
-- served requests kept their `assigned`/`merged` status with no ride at all,
-- since only rides *listed in this payload* get their requests' statuses
-- touched — effectively "requests disappearing", exactly the owner report).
--
-- Fix: the client now sends `payload.mode` ('full' | 'remaining',
-- `src/features/sadran/solverRun.ts`'s `ApplyPayload.mode`, default 'full'
-- for any payload built before this change). In 'remaining' mode this RPC
-- only ever *adds* rides — it never deletes anything. 'full' mode keeps the
-- previous replace-unpinned-drafts behavior unchanged (the dashboard's
-- "החל טיוטה" now confirms with the Sadran first when that would actually
-- discard existing rides — `WeekDashboardScreen.tsx`, client-only change,
-- no migration needed for that part).
--
-- Full body reproduced verbatim from 20260907092600_apply_solver_result_
-- staleness.sql, plus the `v_mode`-guarded delete.
create or replace function public.apply_solver_result(p_department_id uuid, p_week_start date, p_payload jsonb) returns uuid
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
  end loop;

  perform public.assert_car_chain(car_id, p_week_start) from unnest(v_touched_cars) as car_id;

  return v_run_id;
end;
$$;
