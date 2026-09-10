-- apply_solver_result() full mode could strand requests (docs/HARDENING_2026-09.md §2.4):
-- it deleted every non-pinned draft, then re-statused only the requests present in the
-- payload. Requests that lost a draft and are still assigned/merged with no covering ride
-- after the apply go back to `submitted` / 'SOLVER_UNPLACED'; the count is returned as
-- `unplaced_reset`.

CREATE OR REPLACE FUNCTION public.apply_solver_result(p_department_id uuid, p_week_start date, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_series_id uuid;
  v_skipped jsonb := '[]'::jsonb;
  v_series record;
  v_lost uuid[] := '{}';
  v_unplaced int := 0;
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
    -- Remember who is about to lose a draft so the reconcile step below can catch a
    -- payload that forgot to re-status one of them (docs/HARDENING_2026-09.md §2.4).
    select coalesce(array_agg(distinct rr.request_id), '{}') into v_lost
    from public.rides r join public.ride_requests rr on rr.ride_id = r.id
    where r.department_id = p_department_id and r.week_start = p_week_start and r.status = 'draft' and not r.is_pinned;
    delete from public.rides
    where department_id = p_department_id and week_start = p_week_start and status = 'draft' and not is_pinned;
    get diagnostics v_deleted = row_count;
  end if;

  for v_ride in select * from jsonb_array_elements(coalesce(p_payload -> 'rides', '[]'))
  loop
    -- REQ §13.77: denormalize the series onto the ride at INSERT time — rides_before_write()
    -- needs it to skip the turnaround buffer at the 23:59:00 -> 00:00:00 seam.
    select q.series_id into v_series_id
    from jsonb_array_elements(coalesce(v_ride -> 'served', '[]')) s
    join public.requests q on q.id = (s ->> 'request_id')::uuid
    where q.series_id is not null limit 1;

    insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
      driver_id, status, is_pinned, pin_reason, created_by_solver_run_id, created_by, overflow_allowed, series_id)
    values (p_department_id, p_week_start, (v_ride ->> 'car_id')::uuid,
      (v_ride ->> 'starts_at')::timestamptz, (v_ride ->> 'ends_at')::timestamptz,
      (v_ride ->> 'origin_id')::uuid, (v_ride ->> 'destination_id')::uuid,
      (v_ride ->> 'driver_id')::uuid, 'draft',
      coalesce((v_ride ->> 'is_pinned')::boolean, false), v_ride ->> 'pin_reason',
      v_run_id, (select auth.uid()), coalesce((v_ride ->> 'overflow_allowed')::boolean, false), v_series_id)
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

  -- REQ §13.77: a solved leg of a multi-day series drags the rest of the series onto the
  -- same car — including legs in the NEXT week, which place_series() materializes as pinned
  -- 'SERIES_CARRY_OVER' rides. All-or-nothing: if the car cannot take the whole span, this
  -- apply's rides for that series are rolled back (nested block = subtransaction, plus an
  -- explicit delete of the rows inserted above it), its legs go back to `submitted` /
  -- 'SERIES_CAR_UNAVAILABLE', and the caller is told in `skippedSeries` — the rest of the
  -- solve still applies.
  for v_series in
    select r.series_id as sid, (array_agg(r.car_id order by r.starts_at, r.id))[1] as car_id
    from public.rides r
    where r.created_by_solver_run_id = v_run_id and r.series_id is not null
    group by r.series_id
  loop
    begin
      perform public.place_series(v_series.sid, v_series.car_id, false, null);
    exception when others then
      v_skipped := v_skipped || jsonb_build_array(
        jsonb_build_object('series_id', v_series.sid, 'reason', coalesce(nullif(sqlerrm, ''), sqlstate)));
      delete from public.rides
      where created_by_solver_run_id = v_run_id and series_id = v_series.sid;
      perform set_config('app.system_status_transition', 'on', true);
      update public.requests set status = 'submitted', status_reason = 'SERIES_CAR_UNAVAILABLE'
      where series_id = v_series.sid and status not in ('withdrawn', 'cancelled');
      perform set_config('app.system_status_transition', 'off', true);
    end;
  end loop;

  -- Any failure here (a broken car chain, a car away at day end without
  -- acknowledgement, …) raises and unwinds every insert/delete/update this
  -- call made above — apply_solver_result is one PL/pgSQL function
  -- invocation, hence one implicit transaction; there is no partial-apply
  -- outcome, only "fully applied" or "fully rolled back, error surfaced".
  -- A request that lost its draft above and was not re-placed nor re-statused by this
  -- payload must not stay `assigned`/`merged` with no ride: put it back in the queue.
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests q
  set status = 'submitted', status_reason = 'SOLVER_UNPLACED', changed_since_solve = false
  where q.id = any(v_lost) and q.status in ('assigned', 'merged')
    and not exists (select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
                    where rr.request_id = q.id and rd.status <> 'cancelled');
  get diagnostics v_unplaced = row_count;
  perform set_config('app.system_status_transition', 'off', true);
  perform public.assert_car_chain(car_id, p_week_start) from unnest(v_touched_cars) as car_id;

  return jsonb_build_object(
    'run_id', v_run_id,
    'inserted', v_inserted,
    'deleted', v_deleted,
    'unchanged', greatest(v_existing_count - v_deleted, 0),
    'unassigned_requests', coalesce(to_jsonb(v_unassigned), '[]'::jsonb),
    'skippedSeries', v_skipped,
    'unplaced_reset', v_unplaced
  );
end;
$function$;
