-- Stage 3 hardening fix #2 (DATA_MODEL.md §6.1 item 17): `apply_solver_result` never
-- verified `input_hash` server-side (ARCHITECTURE.md §12 invariant 16, DATA_MODEL.md §7
-- describe it doing so; UX_FLOWS.md §15 item 3 records the gap). Client's
-- `hashSolverInput()` (src/features/sadran/solverRun.ts) is a browser-side FNV hash with
-- no server-side equivalent, so this migration adds a real, independent server-computed
-- fingerprint of "this department+week's requests/rides state" instead of trying to
-- reproduce the client's hash formula in SQL.
--
-- `record_solver_preview()` (the dashboard's "run solver" flow, `WeekDashboardScreen.tsx`)
-- now stores that fingerprint alongside the client's opaque `input_hash` at preview time.
-- `apply_solver_result()` looks up the *unapplied* preview row matching the `input_hash`
-- it was given and, if one exists, recomputes the fingerprint now and compares — a
-- mismatch means requests/rides changed under the Sadran between preview and apply, so it
-- raises `stale_input` (SQLSTATE P0409, same class as `stale_version` — `src/lib/rpc.ts`
-- disambiguates by message, see the accompanying TS change).
--
-- The board's "auto-solve remaining" direct-apply path (`BoardScreen.tsx`
-- `handleAutoSolveRemaining`) never calls `record_solver_preview` first (by design — no
-- confirmation sheet, UX_FLOWS §15 item 3's own note), so no matching preview row will
-- exist for its `input_hash` and this check is skipped for that path; it already
-- re-fetches request/ride versions client-side immediately before applying.

-- ---------------------------------------------------------------------------
-- week_state_fingerprint: deterministic digest of a department+week's requests/rides
-- version numbers. Bumps whenever any row is inserted/updated (bump_version()), so any
-- edit_ride/submit_request/cancel_ride/etc. between preview and apply changes it.
-- ---------------------------------------------------------------------------
create or replace function public.week_state_fingerprint(p_department_id uuid, p_week_start date) returns text
language sql stable set search_path = public, pg_temp as $$
  select md5(coalesce(string_agg(x, ',' order by x), ''))
  from (
    select 'r:' || id::text || ':' || version::text as x
    from public.requests where department_id = p_department_id and week_start = p_week_start
    union all
    select 'k:' || id::text || ':' || version::text as x
    from public.rides where department_id = p_department_id and week_start = p_week_start
  ) t;
$$;

alter table public.solver_runs add column state_fingerprint text;

create or replace function public.record_solver_preview(p_department_id uuid, p_week_start date, p_payload jsonb) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_run_id uuid;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  insert into public.solver_runs (department_id, week_start, policy_version_id, input_hash, solver_version,
    status, started_at, finished_at, duration_ms, ran_by, applied, summary, error, state_fingerprint)
  values (p_department_id, p_week_start, (p_payload ->> 'policy_version_id')::uuid, p_payload ->> 'input_hash',
    p_payload ->> 'solver_version', coalesce((p_payload ->> 'status')::public.solver_run_status, 'succeeded'),
    (p_payload ->> 'started_at')::timestamptz, (p_payload ->> 'finished_at')::timestamptz,
    (p_payload ->> 'duration_ms')::int, (select auth.uid()), false, coalesce(p_payload -> 'summary', '{}'),
    p_payload ->> 'error', public.week_state_fingerprint(p_department_id, p_week_start))
  returning id into v_run_id;
  return v_run_id;
end;
$$;

-- apply_solver_result: full body reproduced verbatim from 20260907091500_rpc.sql, plus
-- the staleness check right after authorization/audit-reason and before any writes.
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

  delete from public.rides
  where department_id = p_department_id and week_start = p_week_start and status = 'draft' and not is_pinned;

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
