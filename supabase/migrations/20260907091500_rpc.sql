-- SECURITY DEFINER RPCs: the only write path for requests/rides/proposals and other
-- multi-row or state-changing operations. REQ §5-§9; DATA_MODEL.md §3, §6 step 16.
--
-- Conventions: `set search_path = public, pg_temp`; re-check authorization with the §4.2
-- helpers; `p_expected_version` raises `stale_version` (P0409) on mismatch; `app.audit_reason`
-- is set for audit_row(); status_reason / notification vars use UPPER_SNAKE reason codes,
-- never literal Hebrew (hard rule 3) — the client renders them via lib/errors.ts /
-- src/i18n/he.ts, mirroring src/solver/reasons.ts's reasonCode convention.

create or replace function public.raise_stale_version() returns void
language plpgsql as $$
begin
  raise exception 'stale_version' using errcode = 'P0409';
end;
$$;

-- ---------------------------------------------------------------------------
-- submit_request: the only INSERT/UPDATE path for `requests` (DATA_MODEL §3.6, §4.3).
-- ---------------------------------------------------------------------------
create or replace function public.submit_request(payload jsonb) returns jsonb
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_actor uuid := (select auth.uid());
  v_request_id uuid := nullif(payload ->> 'request_id', '')::uuid;
  v_requester_id uuid := coalesce(nullif(payload ->> 'requester_id', '')::uuid, v_actor);
  v_department_id uuid := (payload ->> 'department_id')::uuid;
  v_week_start date := (payload ->> 'week_start')::date;
  v_trip_shape public.trip_shape := coalesce((payload ->> 'trip_shape')::public.trip_shape, 'round_trip');
  v_depart_at timestamptz := nullif(payload ->> 'depart_at', '')::timestamptz;
  v_return_at timestamptz := nullif(payload ->> 'return_at', '')::timestamptz;
  v_one_way_mode public.leg_car_mode := nullif(payload ->> 'one_way_car_mode', '')::public.leg_car_mode;
  v_needs_car boolean := coalesce((payload ->> 'needs_car_at_destination')::boolean, true);
  v_week record;
  v_existing record;
  v_can_manage boolean;
  v_is_late boolean;
  v_status public.request_status;
  v_warnings jsonb := '[]'::jsonb;
  v_join_ride_id uuid := nullif(payload ->> 'join_ride_id', '')::uuid;
  v_join_car_type public.car_type;
  v_join_owner uuid;
begin
  if v_requester_id <> v_actor then
    if not public.can_manage_week(v_department_id, v_week_start) then
      raise exception 'not_authorized' using errcode = 'P0001';
    end if;
    v_can_manage := true;
  else
    v_can_manage := public.can_manage_week(v_department_id, v_week_start);
  end if;

  select * into v_week from public.weeks where department_id = v_department_id and week_start = v_week_start;
  if v_week is null then
    raise exception 'week_not_open' using errcode = 'P0001';
  end if;

  if v_trip_shape <> 'round_trip' then
    v_needs_car := true;
    if v_one_way_mode is null then
      raise exception 'one_way_car_mode_required' using errcode = 'P0001';
    end if;
  end if;

  if v_request_id is not null then
    select * into v_existing from public.requests where id = v_request_id;
    if v_existing is null then
      raise exception 'request_not_found' using errcode = 'P0001';
    end if;
    if v_existing.requester_id <> v_actor and not public.can_manage_week(v_existing.department_id, v_existing.week_start) then
      raise exception 'not_authorized' using errcode = 'P0001';
    end if;
    if payload ? 'expected_version' and v_existing.version <> (payload ->> 'expected_version')::int then
      perform public.raise_stale_version();
    end if;
  end if;

  v_is_late := now() > v_week.close_at;

  perform set_config('app.audit_reason', 'submit_request', true);

  if v_request_id is null then
    v_status := 'submitted';
    insert into public.requests (
      department_id, week_start, requester_id, filed_by, destination_id, destination_text, ride_type_id,
      trip_shape, depart_at, return_at, one_way_car_mode, needs_car_at_destination,
      adults, child_seats, boosters, has_luggage,
      flex_depart_early, flex_depart_late, flex_return_early, flex_return_late,
      notes, is_late, submitted_at, status, freed_slot_opt_out, join_ride_id, template_id
    ) values (
      v_department_id, v_week_start, v_requester_id, v_actor,
      nullif(payload ->> 'destination_id', '')::uuid, nullif(payload ->> 'destination_text', ''),
      (payload ->> 'ride_type_id')::uuid,
      v_trip_shape, v_depart_at, v_return_at, v_one_way_mode, v_needs_car,
      coalesce((payload ->> 'adults')::smallint, 1), coalesce((payload ->> 'child_seats')::smallint, 0),
      coalesce((payload ->> 'boosters')::smallint, 0), coalesce((payload ->> 'has_luggage')::boolean, false),
      coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_return_early', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_return_late', '')::interval, '0'),
      nullif(payload ->> 'notes', ''), v_is_late, now(), v_status,
      coalesce((payload ->> 'freed_slot_opt_out')::boolean, false),
      v_join_ride_id, nullif(payload ->> 'template_id', '')::uuid
    ) returning id into v_request_id;
  else
    update public.requests set
      destination_id = nullif(payload ->> 'destination_id', '')::uuid,
      destination_text = nullif(payload ->> 'destination_text', ''),
      ride_type_id = (payload ->> 'ride_type_id')::uuid,
      trip_shape = v_trip_shape, depart_at = v_depart_at, return_at = v_return_at,
      one_way_car_mode = v_one_way_mode, needs_car_at_destination = v_needs_car,
      adults = coalesce((payload ->> 'adults')::smallint, adults),
      child_seats = coalesce((payload ->> 'child_seats')::smallint, child_seats),
      boosters = coalesce((payload ->> 'boosters')::smallint, boosters),
      has_luggage = coalesce((payload ->> 'has_luggage')::boolean, has_luggage),
      flex_depart_early = coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, flex_depart_early),
      flex_depart_late = coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, flex_depart_late),
      flex_return_early = coalesce(nullif(payload ->> 'flex_return_early', '')::interval, flex_return_early),
      flex_return_late = coalesce(nullif(payload ->> 'flex_return_late', '')::interval, flex_return_late),
      notes = coalesce(nullif(payload ->> 'notes', ''), notes),
      is_late = v_is_late,
      freed_slot_opt_out = coalesce((payload ->> 'freed_slot_opt_out')::boolean, freed_slot_opt_out),
      join_ride_id = coalesce(v_join_ride_id, join_ride_id),
      changed_since_solve = (v_week.phase <> 'open')
    where id = v_request_id
    returning status into v_status;

    if v_week.phase in ('solving','published') then
      perform public.enqueue_notification(s.profile_id, 'request_changed', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
        format('request_changed:%s:%s', v_request_id, now()))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id);
    end if;
  end if;

  -- Duplicate detection (warn, never block, REQ §5.3).
  if exists (
    select 1 from public.requests q
    where q.requester_id = v_requester_id and q.id <> v_request_id and q.status not in ('withdrawn','cancelled','denied')
      and q.department_id = v_department_id
      and public.request_span(q.depart_at, q.return_at) && public.request_span(v_depart_at, v_return_at)
  ) then
    v_warnings := v_warnings || '"DUPLICATE_OVERLAP"'::jsonb;
  end if;

  -- Seat-fit warning (warn, never block).
  if not exists (
    select 1 from public.cars c join public.car_seat_configs csc on csc.car_id = c.id
    where c.department_id = v_department_id and c.status = 'active'
      and csc.adults >= coalesce((payload ->> 'adults')::smallint, 1)
      and csc.child_seats >= coalesce((payload ->> 'child_seats')::smallint, 0)
      and csc.boosters >= coalesce((payload ->> 'boosters')::smallint, 0)
  ) then
    v_warnings := v_warnings || '"NO_CAR_FITS_SEATS"'::jsonb;
  end if;

  -- "Ask to join" a temporary car: create + send the merge proposal straight to the owner (REQ §13.43).
  if v_join_ride_id is not null then
    select c.type, c.owner_id into v_join_car_type, v_join_owner
    from public.rides r join public.cars c on c.id = r.car_id where r.id = v_join_ride_id;
    if v_join_car_type = 'temporary' then
      perform public.create_proposal(v_request_id, v_join_ride_id, 'merge',
        jsonb_build_object('ride_id', v_join_ride_id, 'legs', jsonb_build_array(
          jsonb_build_object('leg', 'both', 'ride_id', v_join_ride_id, 'car_mode', 'passenger'))),
        'ASK_TO_JOIN_TEMP_CAR', array[v_join_owner], 'ask_to_join');
    end if;
  end if;

  if v_week.phase = 'live' and v_trip_shape = 'round_trip' then
    perform public.try_auto_approve(v_request_id);
  elsif v_week.phase = 'live' then
    update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_ONE_WAY' where id = v_request_id;
    perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
      jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
      format('waitlisted_request:%s', v_request_id))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id);
  end if;

  if v_is_late then
    perform public.enqueue_notification(s.profile_id, 'late_request', v_department_id, v_week_start,
      jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
      format('late_request:%s', v_request_id))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id);
  end if;

  return jsonb_build_object('request_id', v_request_id, 'is_late', v_is_late, 'warnings', v_warnings);
end;
$$;

revoke execute on function public.submit_request(jsonb) from public, anon;
grant execute on function public.submit_request(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- withdraw_request
-- ---------------------------------------------------------------------------
create or replace function public.withdraw_request(p_request_id uuid, p_expected_version int) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_req record;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if v_req.requester_id <> (select auth.uid()) and not public.can_manage_week(v_req.department_id, v_req.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if v_req.version <> p_expected_version then perform public.raise_stale_version(); end if;

  perform set_config('app.audit_reason', 'withdraw_request', true);
  update public.requests set status = 'withdrawn', status_reason = 'WITHDRAWN_BY_MEMBER' where id = p_request_id;
end;
$$;

revoke execute on function public.withdraw_request(uuid, int) from public, anon;
grant execute on function public.withdraw_request(uuid, int) to authenticated;

-- ---------------------------------------------------------------------------
-- set_manual_boost (Sadran only)
-- ---------------------------------------------------------------------------
create or replace function public.set_manual_boost(p_request_id uuid, p_value numeric, p_reason text) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_req record;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_req.department_id, v_req.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_value <> 0 and (p_reason is null or length(trim(p_reason)) = 0) then
    raise exception 'manual_boost_requires_reason' using errcode = 'P0001';
  end if;
  perform set_config('app.audit_reason', 'set_manual_boost', true);
  update public.requests set manual_boost = p_value, manual_boost_reason = p_reason where id = p_request_id;
end;
$$;

revoke execute on function public.set_manual_boost(uuid, numeric, text) from public, anon;
grant execute on function public.set_manual_boost(uuid, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------
-- open_week / set_week_phase
-- ---------------------------------------------------------------------------
create or replace function public.open_week(p_department_id uuid, p_week_start date) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_settings record;
  v_open_at timestamptz;
  v_close_at timestamptz;
  v_publish_at timestamptz;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  select * into v_settings from public.department_settings where department_id = p_department_id;

  v_open_at := ((p_week_start - 7 + v_settings.open_dow) + v_settings.open_time) at time zone 'Asia/Jerusalem';
  v_close_at := ((p_week_start - 7 + v_settings.close_dow) + v_settings.close_time) at time zone 'Asia/Jerusalem';
  v_publish_at := ((p_week_start - 7 + v_settings.publish_dow) + v_settings.publish_time) at time zone 'Asia/Jerusalem';

  perform set_config('app.audit_reason', 'open_week', true);
  insert into public.weeks (department_id, week_start, phase, open_at, close_at, publish_at, opened_by)
  values (p_department_id, p_week_start, 'open', v_open_at, v_close_at, v_publish_at, (select auth.uid()))
  on conflict (department_id, week_start) do nothing;

  perform public.enqueue_notification(dm.profile_id, 'window_open', p_department_id, p_week_start,
    '{}'::jsonb, '{}'::jsonb, format('window_open:%s:%s', p_department_id, p_week_start))
  from public.department_members dm where dm.department_id = p_department_id and dm.removed_at is null;

  return p_department_id;
end;
$$;

revoke execute on function public.open_week(uuid, date) from public, anon;
grant execute on function public.open_week(uuid, date) to authenticated;

create or replace function public.set_week_phase(p_department_id uuid, p_week_start date, p_phase public.week_phase) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  perform set_config('app.audit_reason', 'set_week_phase', true);
  update public.weeks set phase = p_phase where department_id = p_department_id and week_start = p_week_start;

  if p_phase = 'solving' then
    perform public.enqueue_notification(s.profile_id, 'window_closed_solve_now', p_department_id, p_week_start,
      '{}'::jsonb, '{}'::jsonb, format('window_closed_solve_now:%s:%s', p_department_id, p_week_start))
    from public.sadranim_of(p_department_id, p_week_start) as s(profile_id);
  end if;
end;
$$;

revoke execute on function public.set_week_phase(uuid, date, public.week_phase) from public, anon;
grant execute on function public.set_week_phase(uuid, date, public.week_phase) to authenticated;

-- ---------------------------------------------------------------------------
-- try_auto_approve: REQ §8 "new request on a free car" (live phase, round trips only,
-- invariant #20). Returns the resulting request status.
-- ---------------------------------------------------------------------------
create or replace function public.try_auto_approve(p_request_id uuid) returns public.request_status
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_req record;
  v_car record;
  v_home uuid;
  v_turnaround interval;
  v_ride_id uuid;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req.trip_shape <> 'round_trip' then
    return null;
  end if;

  select d.home_destination_id into v_home from public.departments d where d.id = v_req.department_id;
  if v_home is null then
    update public.requests set status = 'waitlisted', status_reason = 'NO_HOME_LOCATION' where id = p_request_id;
    return 'waitlisted';
  end if;

  select make_interval(mins => s.turnaround_minutes) into v_turnaround
  from public.department_settings s where s.department_id = v_req.department_id;

  select c.* into v_car
  from public.cars c
  join public.car_seat_configs csc on csc.car_id = c.id
  where c.department_id = v_req.department_id and c.status = 'active' and c.type = 'shared'
    and csc.adults >= v_req.adults and csc.child_seats >= v_req.child_seats and csc.boosters >= v_req.boosters
    and public.car_location_at(c.id, v_req.depart_at) = v_home
    and not exists (
      select 1 from public.rides r
      where r.car_id = c.id and r.status <> 'cancelled'
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_req.depart_at, v_req.return_at + v_turnaround, '[)')
    )
  order by c.id limit 1;

  if v_car.id is null then
    perform set_config('app.audit_reason', 'try_auto_approve:no_car', true);
    update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_NO_CAR' where id = p_request_id;
    perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_req.department_id, v_req.week_start,
      jsonb_build_object('requestId', p_request_id::text), jsonb_build_object('request_id', p_request_id),
      format('waitlisted_request:%s', p_request_id))
    from public.sadranim_of(v_req.department_id, v_req.week_start) as s(profile_id);
    return 'waitlisted';
  end if;

  perform set_config('app.audit_reason', 'try_auto_approve:assigned', true);
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, is_pinned, pin_reason, created_by)
  values (v_req.department_id, v_req.week_start, v_car.id, v_req.depart_at, v_req.return_at, v_home, v_home,
    v_req.requester_id, 'confirmed', true, 'AUTO_APPROVED', v_req.requester_id)
  returning id into v_ride_id;

  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
  values (v_ride_id, p_request_id, 'driver', 'both', 'keep');

  perform public.assert_car_chain(v_car.id, v_req.week_start);

  update public.requests set status = 'assigned', status_reason = 'AUTO_APPROVED_FREE_CAR' where id = p_request_id;

  perform public.enqueue_notification(v_req.requester_id, 'auto_approved', v_req.department_id, v_req.week_start,
    jsonb_build_object('requestId', p_request_id::text), jsonb_build_object('request_id', p_request_id, 'ride_id', v_ride_id),
    format('auto_approved:%s', p_request_id));
  perform public.enqueue_notification(s.profile_id, 'auto_approved', v_req.department_id, v_req.week_start,
    jsonb_build_object('requestId', p_request_id::text), jsonb_build_object('request_id', p_request_id, 'ride_id', v_ride_id),
    format('auto_approved:%s:%s', p_request_id, s.profile_id))
  from public.sadranim_of(v_req.department_id, v_req.week_start) as s(profile_id);

  return 'assigned';
end;
$$;

revoke execute on function public.try_auto_approve(uuid) from public, anon;
grant execute on function public.try_auto_approve(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- apply_solver_result: one transaction (invariant #16). p_payload:
-- { input_hash, solver_version, policy_version_id, started_at, finished_at, duration_ms,
--   summary, rides: [{ car_id, starts_at, ends_at, origin_id, destination_id, driver_id,
--     is_pinned, pin_reason, served: [{request_id, role, leg, car_mode, detour_minutes}] }],
--   request_statuses: [{request_id, status, status_reason}] }
-- Deletes unpinned draft rides of the week, inserts the new draft, updates request
-- statuses, records the solver_runs row, then re-checks the car chain per touched car.
-- ---------------------------------------------------------------------------
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
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'apply_solver_result', true);

  insert into public.solver_runs (department_id, week_start, policy_version_id, input_hash, solver_version,
    status, started_at, finished_at, duration_ms, ran_by, applied, summary)
  values (p_department_id, p_week_start, (p_payload ->> 'policy_version_id')::uuid, p_payload ->> 'input_hash',
    p_payload ->> 'solver_version', 'succeeded', (p_payload ->> 'started_at')::timestamptz,
    (p_payload ->> 'finished_at')::timestamptz, (p_payload ->> 'duration_ms')::int,
    (select auth.uid()), true, coalesce(p_payload -> 'summary', '{}'))
  returning id into v_run_id;

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

revoke execute on function public.apply_solver_result(uuid, date, jsonb) from public, anon;
grant execute on function public.apply_solver_result(uuid, date, jsonb) to authenticated;

create or replace function public.record_solver_preview(p_department_id uuid, p_week_start date, p_payload jsonb) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_run_id uuid;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  insert into public.solver_runs (department_id, week_start, policy_version_id, input_hash, solver_version,
    status, started_at, finished_at, duration_ms, ran_by, applied, summary, error)
  values (p_department_id, p_week_start, (p_payload ->> 'policy_version_id')::uuid, p_payload ->> 'input_hash',
    p_payload ->> 'solver_version', coalesce((p_payload ->> 'status')::public.solver_run_status, 'succeeded'),
    (p_payload ->> 'started_at')::timestamptz, (p_payload ->> 'finished_at')::timestamptz,
    (p_payload ->> 'duration_ms')::int, (select auth.uid()), false, coalesce(p_payload -> 'summary', '{}'),
    p_payload ->> 'error')
  returning id into v_run_id;
  return v_run_id;
end;
$$;

revoke execute on function public.record_solver_preview(uuid, date, jsonb) from public, anon;
grant execute on function public.record_solver_preview(uuid, date, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- edit_ride: the Sadran's single-ride create/move/reassign/pin path.
-- p_ride: { id?, car_id, starts_at, ends_at, origin_id, destination_id, driver_id,
--   overflow_allowed?, overnight_ack?, is_pinned?, pin_reason?, served: [...] } (see apply_solver_result)
-- ---------------------------------------------------------------------------
create or replace function public.edit_ride(p_ride jsonb, p_expected_version int default null) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_ride_id uuid := nullif(p_ride ->> 'id', '')::uuid;
  v_department_id uuid := (p_ride ->> 'department_id')::uuid;
  v_week_start date := (p_ride ->> 'week_start')::date;
  v_existing record;
  v_served jsonb;
begin
  if not public.can_manage_week(v_department_id, v_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'edit_ride', true);

  if v_ride_id is not null then
    select * into v_existing from public.rides where id = v_ride_id;
    if v_existing is null then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    if p_expected_version is not null and v_existing.version <> p_expected_version then
      perform public.raise_stale_version();
    end if;

    update public.rides set
      car_id = (p_ride ->> 'car_id')::uuid,
      starts_at = (p_ride ->> 'starts_at')::timestamptz,
      ends_at = (p_ride ->> 'ends_at')::timestamptz,
      origin_id = (p_ride ->> 'origin_id')::uuid,
      destination_id = (p_ride ->> 'destination_id')::uuid,
      driver_id = (p_ride ->> 'driver_id')::uuid,
      overflow_allowed = coalesce((p_ride ->> 'overflow_allowed')::boolean, overflow_allowed),
      overnight_ack_by = case when (p_ride ->> 'overnight_ack')::boolean then (select auth.uid()) else overnight_ack_by end,
      overnight_ack_at = case when (p_ride ->> 'overnight_ack')::boolean then now() else overnight_ack_at end,
      is_pinned = coalesce((p_ride ->> 'is_pinned')::boolean, true),
      pin_reason = coalesce(p_ride ->> 'pin_reason', 'SADRAN_EDIT')
    where id = v_ride_id;

    delete from public.ride_requests where ride_id = v_ride_id;
  else
    insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
      driver_id, status, is_pinned, pin_reason, created_by, overflow_allowed)
    values (v_department_id, v_week_start, (p_ride ->> 'car_id')::uuid,
      (p_ride ->> 'starts_at')::timestamptz, (p_ride ->> 'ends_at')::timestamptz,
      (p_ride ->> 'origin_id')::uuid, (p_ride ->> 'destination_id')::uuid, (p_ride ->> 'driver_id')::uuid,
      'draft', true, coalesce(p_ride ->> 'pin_reason', 'SADRAN_MANUAL'), (select auth.uid()),
      coalesce((p_ride ->> 'overflow_allowed')::boolean, false))
    returning id into v_ride_id;
  end if;

  for v_served in select * from jsonb_array_elements(coalesce(p_ride -> 'served', '[]'))
  loop
    insert into public.ride_requests (ride_id, request_id, role, leg, car_mode, detour_minutes)
    values (v_ride_id, (v_served ->> 'request_id')::uuid, (v_served ->> 'role')::public.ride_role,
      coalesce((v_served ->> 'leg')::public.ride_leg, 'both'), (v_served ->> 'car_mode')::public.leg_car_mode,
      coalesce((v_served ->> 'detour_minutes')::smallint, 0));

    update public.requests set status = 'merged', status_reason = 'SADRAN_ASSIGNED'
    where id = (v_served ->> 'request_id')::uuid and (v_served ->> 'role') = 'passenger';
    update public.requests set status = 'assigned', status_reason = 'SADRAN_ASSIGNED'
    where id = (v_served ->> 'request_id')::uuid and (v_served ->> 'role') = 'driver';
  end loop;

  perform public.assert_car_chain((p_ride ->> 'car_id')::uuid, v_week_start);

  return v_ride_id;
end;
$$;

revoke execute on function public.edit_ride(jsonb, int) from public, anon;
grant execute on function public.edit_ride(jsonb, int) to authenticated;

-- ---------------------------------------------------------------------------
-- cancel_ride: member's own ride, or Sadran/Admin. Relay leg -> flag the partner leg
-- (no offer, REQ §13.63); otherwise creates a freed_slot_offers row.
-- ---------------------------------------------------------------------------
create or replace function public.cancel_ride(p_ride_id uuid, p_reason text, p_expected_version int default null) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_ride record;
  v_is_relay boolean;
  v_offer_id uuid;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride is null then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if v_ride.driver_id <> (select auth.uid()) and not public.can_manage_week(v_ride.department_id, v_ride.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_expected_version is not null and v_ride.version <> p_expected_version then
    perform public.raise_stale_version();
  end if;

  perform set_config('app.audit_reason', coalesce(p_reason, 'cancel_ride'), true);

  select exists (select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.car_mode = 'relay')
    into v_is_relay;

  update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = (select auth.uid()),
    cancel_reason = coalesce(p_reason, 'CANCELLED_BY_MEMBER')
  where id = p_ride_id;

  update public.requests set status = 'cancelled', status_reason = 'RIDE_CANCELLED'
  where id in (select request_id from public.ride_requests where ride_id = p_ride_id);

  if v_is_relay then
    -- Flag the partner leg for the Sadran instead of opening a freed-slot offer (REQ §13.63).
    update public.rides set status = 'flagged', flag_reason = 'relay_pair_cancelled'
    where car_id = v_ride.car_id and week_start = v_ride.week_start and status <> 'cancelled'
      and (origin_id = v_ride.destination_id or destination_id = v_ride.origin_id) and id <> p_ride_id;
    return;
  end if;

  if v_ride.origin_id = v_ride.destination_id then
    insert into public.freed_slot_offers (department_id, week_start, car_id, cancelled_ride_id, starts_at, ends_at, expires_at)
    values (v_ride.department_id, v_ride.week_start, v_ride.car_id, p_ride_id, v_ride.starts_at, v_ride.ends_at, v_ride.starts_at)
    returning id into v_offer_id;

    -- Notify the on-ride-cancelled edge function (pg_net) if configured; a no-op locally
    -- until app_settings.on_ride_cancelled_url is set, so this never breaks db reset/tests.
    perform net.http_post(
      url := cfg.url_val,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', coalesce(cfg.secret_val, '')),
      body := jsonb_build_object('offer_id', v_offer_id)
    )
    from (
      select
        (select value ->> 'value' from public.app_settings where key = 'on_ride_cancelled_url') as url_val,
        (select value ->> 'value' from public.app_settings where key = 'cron_secret') as secret_val
    ) cfg
    where cfg.url_val is not null and cfg.url_val <> '';
  end if;
end;
$$;

revoke execute on function public.cancel_ride(uuid, text, int) from public, anon;
grant execute on function public.cancel_ride(uuid, text, int) to authenticated;

-- ---------------------------------------------------------------------------
-- Proposal tokens: a random 128-bit secret, base64url; only sha256(token) is stored
-- (ARCHITECTURE §8). Plain tokens are returned to the caller once.
-- ---------------------------------------------------------------------------
create or replace function public.generate_token() returns text
language sql volatile as $$
  select translate(encode(gen_random_bytes(16), 'base64'), '+/=', '-_');
$$;

-- ---------------------------------------------------------------------------
-- create_proposal / send_proposal (DATA_MODEL §3.8, §6 step 16).
-- ---------------------------------------------------------------------------
create or replace function public.create_proposal(
  p_request_id uuid, p_ride_id uuid, p_type public.proposal_type, p_payload jsonb,
  p_reason_he text, p_party_profile_ids uuid[] default '{}', p_created_via text default 'sadran'
) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_req record;
  v_proposal_id uuid;
  v_token text;
  v_party uuid;
  v_expires_at timestamptz;
  v_settings record;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;

  if p_created_via = 'sadran' and not public.can_manage_week(v_req.department_id, v_req.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  elsif p_created_via = 'ask_to_join' and v_req.requester_id <> (select auth.uid())
        and not public.can_manage_week(v_req.department_id, v_req.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  select * into v_settings from public.department_settings where department_id = v_req.department_id;
  v_expires_at := case when v_settings.proposal_expiry_mode = 'fixed_hours'
    then now() + make_interval(hours => v_settings.proposal_expiry_hours)
    else (select w.publish_at from public.weeks w where w.department_id = v_req.department_id and w.week_start = v_req.week_start)
    end;

  v_token := public.generate_token();
  perform set_config('app.audit_reason', 'create_proposal', true);

  insert into public.proposals (department_id, week_start, type, status, request_id, ride_id, payload, reason_he,
    previous_status, token_hash, expires_at, created_by, created_via)
  values (v_req.department_id, v_req.week_start, p_type, 'draft', p_request_id, p_ride_id, p_payload, p_reason_he,
    v_req.status, encode(digest(v_token, 'sha256'), 'hex'), v_expires_at, (select auth.uid()), p_created_via)
  returning id into v_proposal_id;

  v_token := public.generate_token();
  insert into public.proposal_parties (proposal_id, profile_id, request_id, token_hash)
  values (v_proposal_id, v_req.requester_id, p_request_id, encode(digest(v_token, 'sha256'), 'hex'));

  foreach v_party in array coalesce(p_party_profile_ids, '{}') loop
    if v_party <> v_req.requester_id then
      v_token := public.generate_token();
      insert into public.proposal_parties (proposal_id, profile_id, token_hash)
      values (v_proposal_id, v_party, encode(digest(v_token, 'sha256'), 'hex'))
      on conflict (proposal_id, profile_id) do nothing;
    end if;
  end loop;

  return v_proposal_id;
end;
$$;

revoke execute on function public.create_proposal(uuid, uuid, public.proposal_type, jsonb, text, uuid[], text) from public, anon;
grant execute on function public.create_proposal(uuid, uuid, public.proposal_type, jsonb, text, uuid[], text) to authenticated;

create or replace function public.send_proposal(p_proposal_id uuid, p_sent_via public.notification_channel[] default '{}') returns jsonb
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_prop record;
  v_requester_id uuid;
  v_token text;
  v_proposal_token text;
  v_party_tokens jsonb := '{}'::jsonb;
  v_party record;
begin
  select * into v_prop from public.proposals where id = p_proposal_id;
  if v_prop is null then raise exception 'proposal_not_found' using errcode = 'P0001'; end if;
  if v_prop.created_via = 'sadran' and not public.can_manage_week(v_prop.department_id, v_prop.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if v_prop.status <> 'draft' then raise exception 'proposal_not_draft' using errcode = 'P0001'; end if;

  perform set_config('app.audit_reason', 'send_proposal', true);

  v_proposal_token := public.generate_token();
  update public.proposals set token_hash = encode(digest(v_proposal_token, 'sha256'), 'hex'), status = 'sent',
    sent_at = now(), sent_via = p_sent_via
  where id = p_proposal_id;

  for v_party in select id, profile_id from public.proposal_parties where proposal_id = p_proposal_id loop
    v_token := public.generate_token();
    update public.proposal_parties set token_hash = encode(digest(v_token, 'sha256'), 'hex') where id = v_party.id;
    v_party_tokens := v_party_tokens || jsonb_build_object(v_party.profile_id::text, v_token);
  end loop;

  select requester_id into v_requester_id from public.requests where id = v_prop.request_id;
  perform public.enqueue_notification(v_requester_id, 'proposal_received', v_prop.department_id, v_prop.week_start,
    '{}'::jsonb, jsonb_build_object('proposal_id', p_proposal_id), format('proposal_received:%s', p_proposal_id));

  return jsonb_build_object('proposal_token', v_proposal_token, 'party_tokens', v_party_tokens);
end;
$$;

revoke execute on function public.send_proposal(uuid, public.notification_channel[]) from public, anon;
grant execute on function public.send_proposal(uuid, public.notification_channel[]) to authenticated;

-- ---------------------------------------------------------------------------
-- answer_proposal: token variant (no sign-in — ARCHITECTURE §8), called by the
-- answer-proposal edge function with the service role. p_via defaults to 'token'.
-- ---------------------------------------------------------------------------
create or replace function public.answer_proposal(p_token text, p_accept boolean, p_note text default null,
  p_via public.answer_channel default 'token') returns jsonb
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_hash text := encode(digest(p_token, 'sha256'), 'hex');
  v_proposal record;
  v_party record;
  v_requester_id uuid;
begin
  select * into v_proposal from public.proposals where token_hash = v_hash;
  if v_proposal is not null then
    if v_proposal.status <> 'sent' then raise exception 'proposal_not_answerable' using errcode = 'P0001'; end if;
    if now() > v_proposal.expires_at then raise exception 'proposal_expired' using errcode = 'P0001'; end if;

    select requester_id into v_requester_id from public.requests where id = v_proposal.request_id;
    perform set_config('app.audit_reason', 'answer_proposal', true);

    update public.proposal_parties set response = case when p_accept then 'accepted' else 'declined' end,
      responded_at = now(), responded_via = p_via, responded_by = v_requester_id
    where proposal_id = v_proposal.id and profile_id = v_requester_id;

    update public.proposals set answered_by = v_requester_id, answered_at = now(), answered_via = p_via, answer_note = p_note
    where id = v_proposal.id;

    return jsonb_build_object('proposal_id', v_proposal.id, 'accepted', p_accept);
  end if;

  select pp.*, p.status as proposal_status, p.expires_at as proposal_expires_at, p.id as proposal_id
    into v_party
  from public.proposal_parties pp join public.proposals p on p.id = pp.proposal_id
  where pp.token_hash = v_hash;
  if v_party is null then raise exception 'invalid_token' using errcode = 'P0001'; end if;
  if v_party.proposal_status <> 'sent' then raise exception 'proposal_not_answerable' using errcode = 'P0001'; end if;
  if now() > v_party.proposal_expires_at then raise exception 'proposal_expired' using errcode = 'P0001'; end if;

  perform set_config('app.audit_reason', 'answer_proposal', true);
  update public.proposal_parties set response = case when p_accept then 'accepted' else 'declined' end,
    responded_at = now(), responded_via = p_via, responded_by = v_party.profile_id
  where id = v_party.id;

  update public.proposals set answered_by = v_party.profile_id, answered_at = now(), answered_via = p_via, answer_note = p_note
  where id = v_party.proposal_id and answered_by is null;

  return jsonb_build_object('proposal_id', v_party.proposal_id, 'accepted', p_accept);
end;
$$;

revoke execute on function public.answer_proposal(text, boolean, text, public.answer_channel) from public, anon;
grant execute on function public.answer_proposal(text, boolean, text, public.answer_channel) to authenticated;

-- ---------------------------------------------------------------------------
-- record_answer_on_behalf: the Sadran records a WhatsApp answer manually.
-- ---------------------------------------------------------------------------
create or replace function public.record_answer_on_behalf(p_proposal_id uuid, p_profile_id uuid, p_accept boolean, p_note text default null) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_prop record;
begin
  select * into v_prop from public.proposals where id = p_proposal_id;
  if v_prop is null then raise exception 'proposal_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_prop.department_id, v_prop.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if v_prop.status <> 'sent' then raise exception 'proposal_not_answerable' using errcode = 'P0001'; end if;

  perform set_config('app.audit_reason', 'record_answer_on_behalf', true);
  update public.proposal_parties set response = case when p_accept then 'accepted' else 'declined' end,
    responded_at = now(), responded_via = 'sadran', responded_by = (select auth.uid())
  where proposal_id = p_proposal_id and profile_id = p_profile_id;

  update public.proposals set answered_by = coalesce(answered_by, p_profile_id), answered_at = coalesce(answered_at, now()),
    answered_via = coalesce(answered_via, 'sadran'), answer_note = coalesce(p_note, answer_note)
  where id = p_proposal_id;
end;
$$;

revoke execute on function public.record_answer_on_behalf(uuid, uuid, boolean, text) from public, anon;
grant execute on function public.record_answer_on_behalf(uuid, uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- apply_proposal: updates the draft siddur once every party has accepted; rides created
-- this way are pinned (REQ §7.3). `shift` without a chosen car updates the request's
-- window and returns it to `submitted` for the Sadran to place on the board (a documented
-- simplification: the full "shift already assigns a specific pinned ride" behavior needs a
-- car_id in the proposal payload, which the composer UI supplies when it knows one).
-- ---------------------------------------------------------------------------
create or replace function public.apply_proposal(p_proposal_id uuid) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_prop record;
  v_req record;
  v_ride_id uuid;
  v_leg jsonb;
  v_has_driver_leg boolean;
begin
  select * into v_prop from public.proposals where id = p_proposal_id;
  if v_prop is null then raise exception 'proposal_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_prop.department_id, v_prop.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if v_prop.status <> 'accepted' then raise exception 'proposal_not_accepted' using errcode = 'P0001'; end if;

  select * into v_req from public.requests where id = v_prop.request_id;
  perform set_config('app.audit_reason', 'apply_proposal', true);

  if v_prop.type = 'deny' then
    update public.requests set status = 'denied', status_reason = coalesce(v_prop.payload ->> 'reason', 'DENIED_BY_SADRAN')
    where id = v_prop.request_id;
  elsif v_prop.type = 'external' then
    update public.requests set status = 'external', status_reason = coalesce(v_prop.payload ->> 'reason', 'EXTERNAL')
    where id = v_prop.request_id;
  elsif v_prop.type = 'shift' then
    if v_prop.payload ? 'car_id' then
      v_ride_id := public.edit_ride(jsonb_build_object(
        'department_id', v_prop.department_id, 'week_start', v_prop.week_start,
        'car_id', v_prop.payload ->> 'car_id',
        'starts_at', coalesce(v_prop.payload ->> 'depart_at', v_req.depart_at::text),
        'ends_at', coalesce(v_prop.payload ->> 'return_at', v_req.return_at::text),
        'origin_id', v_prop.payload ->> 'origin_id', 'destination_id', v_prop.payload ->> 'destination_id',
        'driver_id', v_req.requester_id::text, 'is_pinned', true, 'pin_reason', 'PROPOSAL_APPLIED',
        'served', jsonb_build_array(jsonb_build_object('request_id', v_prop.request_id, 'role', 'driver', 'leg', 'both', 'car_mode', 'keep'))
      ));
      update public.requests set
        depart_at = coalesce((v_prop.payload ->> 'depart_at')::timestamptz, depart_at),
        return_at = coalesce((v_prop.payload ->> 'return_at')::timestamptz, return_at),
        status = 'assigned', status_reason = 'PROPOSAL_APPLIED'
      where id = v_prop.request_id;
    else
      update public.requests set
        depart_at = coalesce((v_prop.payload ->> 'depart_at')::timestamptz, depart_at),
        return_at = coalesce((v_prop.payload ->> 'return_at')::timestamptz, return_at),
        trip_shape = coalesce((v_prop.payload ->> 'trip_shape')::public.trip_shape, trip_shape),
        needs_car_at_destination = coalesce((v_prop.payload ->> 'needs_car_at_destination')::boolean, needs_car_at_destination),
        status = 'submitted', status_reason = 'PROPOSAL_APPLIED_PENDING_ASSIGNMENT'
      where id = v_prop.request_id;
    end if;
  elsif v_prop.type = 'merge' then
    v_has_driver_leg := false;
    for v_leg in select * from jsonb_array_elements(coalesce(v_prop.payload -> 'legs', '[]')) loop
      v_ride_id := (v_leg ->> 'ride_id')::uuid;
      insert into public.ride_requests (ride_id, request_id, role, leg, car_mode, detour_minutes)
      values (v_ride_id, v_prop.request_id, coalesce((v_leg ->> 'role')::public.ride_role, 'passenger'),
        coalesce((v_leg ->> 'leg')::public.ride_leg, 'both'), (v_leg ->> 'car_mode')::public.leg_car_mode,
        coalesce((v_prop.payload ->> 'detour_minutes')::smallint, 0))
      on conflict (ride_id, request_id, leg) do update set car_mode = excluded.car_mode;
      update public.rides set is_pinned = true, pin_reason = 'PROPOSAL_APPLIED' where id = v_ride_id;
      if (v_leg ->> 'role') = 'driver' then
        v_has_driver_leg := true;
      end if;
      perform public.assert_car_chain(r.car_id, r.week_start) from public.rides r where r.id = v_ride_id;
    end loop;
    update public.requests set status = case when v_has_driver_leg then 'assigned' else 'merged' end,
      status_reason = 'PROPOSAL_APPLIED'
    where id = v_prop.request_id;
  end if;

  update public.proposals set status = 'applied', applied_at = now(), applied_ride_id = v_ride_id where id = p_proposal_id;

  perform public.enqueue_notification(v_req.requester_id, 'outcome_changed', v_prop.department_id, v_prop.week_start,
    '{}'::jsonb, jsonb_build_object('request_id', v_prop.request_id), format('outcome_changed:%s:%s', v_prop.request_id, p_proposal_id));

  return v_ride_id;
end;
$$;

revoke execute on function public.apply_proposal(uuid) from public, anon;
grant execute on function public.apply_proposal(uuid) to authenticated;

-- Applies an accepted proposal automatically when the department opts in
-- (department_settings.auto_apply_accepted_proposals, UX_FLOWS §4.3/§5.10).
create or replace function public.maybe_apply_accepted_proposal(p_proposal_id uuid) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_prop record; v_auto boolean;
begin
  select * into v_prop from public.proposals where id = p_proposal_id;
  if v_prop is null or v_prop.status <> 'accepted' then
    return;
  end if;
  select auto_apply_accepted_proposals into v_auto from public.department_settings where department_id = v_prop.department_id;
  if v_auto then
    perform public.apply_proposal(p_proposal_id);
  end if;
end;
$$;

revoke execute on function public.maybe_apply_accepted_proposal(uuid) from public, anon;

-- ---------------------------------------------------------------------------
-- publish_siddur: freezes a siddur version, flips draft rides to confirmed, notifies
-- (first publish: everyone with an outcome; republish: only changed outcomes). REQ §7.5.
-- ---------------------------------------------------------------------------
create or replace function public.publish_siddur(p_department_id uuid, p_week_start date) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_snapshot jsonb;
  v_version_id uuid;
  v_prev record;
  v_phase public.week_phase;
  v_req record;
  v_notified int := 0;
  v_prev_status text;
  v_event public.notification_event;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  select * into v_prev from public.siddur_versions
  where department_id = p_department_id and week_start = p_week_start order by version_no desc limit 1;

  select jsonb_build_object(
    'rides', (select coalesce(jsonb_agg(to_jsonb(r)), '[]') from public.rides r
              where r.department_id = p_department_id and r.week_start = p_week_start and r.status <> 'cancelled'),
    'requests', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', q.id, 'requester_id', q.requester_id, 'status', q.status, 'status_reason', q.status_reason)), '[]')
                 from public.requests q where q.department_id = p_department_id and q.week_start = p_week_start),
    'cars', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from public.cars c where c.department_id = p_department_id),
    'blocks', (select coalesce(jsonb_agg(to_jsonb(b)), '[]') from public.car_maintenance_blocks b where b.department_id = p_department_id)
  ) into v_snapshot;

  perform set_config('app.audit_reason', 'publish_siddur', true);
  perform set_config('app.in_publish', 'on', true);

  insert into public.siddur_versions (department_id, week_start, snapshot, published_by)
  values (p_department_id, p_week_start, v_snapshot, (select auth.uid()))
  returning id into v_version_id;

  v_phase := case when p_week_start <= public.current_week_start() then 'live' else 'published' end;

  update public.weeks set published_version_id = v_version_id, published_at = now(), phase = v_phase
  where department_id = p_department_id and week_start = p_week_start;

  update public.rides set status = 'confirmed'
  where department_id = p_department_id and week_start = p_week_start and status = 'draft';

  perform set_config('app.in_publish', 'off', true);

  for v_req in
    select id, requester_id, status from public.requests
    where department_id = p_department_id and week_start = p_week_start and status not in ('draft', 'withdrawn')
  loop
    v_prev_status := null;
    if v_prev is not null then
      select elem ->> 'status' into v_prev_status
      from jsonb_array_elements(v_prev.snapshot -> 'requests') elem
      where (elem ->> 'id')::uuid = v_req.id;
    end if;

    if v_prev is null then
      v_event := 'published';
    elsif v_prev_status is distinct from v_req.status::text then
      v_event := 'outcome_changed';
    else
      continue;
    end if;

    perform public.enqueue_notification(v_req.requester_id, v_event, p_department_id, p_week_start,
      '{}'::jsonb, jsonb_build_object('request_id', v_req.id), format('%s:%s:%s', v_event, v_version_id, v_req.id));
    v_notified := v_notified + 1;
  end loop;

  update public.siddur_versions set notified_count = v_notified where id = v_version_id;

  return v_version_id;
end;
$$;

revoke execute on function public.publish_siddur(uuid, date) from public, anon;
grant execute on function public.publish_siddur(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- resolve_freed_offer: 0 candidates -> closed; 1 -> auto-assign; >1 -> offer claims
-- (called by the on-ride-cancelled edge function with candidates ranked by matchFreedSlot).
-- ---------------------------------------------------------------------------
create or replace function public.resolve_freed_offer(p_offer_id uuid, p_ranked_candidates jsonb) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_offer record;
  v_count int;
  v_first jsonb;
  v_ride_id uuid;
  v_cand jsonb;
begin
  select * into v_offer from public.freed_slot_offers where id = p_offer_id;
  if v_offer is null then raise exception 'offer_not_found' using errcode = 'P0001'; end if;
  if v_offer.status <> 'open' then raise exception 'offer_not_open' using errcode = 'P0001'; end if;

  v_count := jsonb_array_length(coalesce(p_ranked_candidates, '[]'));
  perform set_config('app.audit_reason', 'resolve_freed_offer', true);

  if v_count = 0 then
    update public.freed_slot_offers set status = 'closed', resolved_at = now() where id = p_offer_id;
  elsif v_count = 1 then
    v_first := p_ranked_candidates -> 0;
    insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
      driver_id, status, is_pinned, pin_reason, created_by)
    select r.department_id, r.week_start, v_offer.car_id, q.depart_at, q.return_at, r.origin_id, r.destination_id,
      q.requester_id, 'confirmed', true, 'FREED_SLOT_AUTO', q.requester_id
    from public.rides r, public.requests q
    where r.id = v_offer.cancelled_ride_id and q.id = (v_first ->> 'request_id')::uuid
    returning id into v_ride_id;

    insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
    values (v_ride_id, (v_first ->> 'request_id')::uuid, 'driver', 'both', 'keep');

    perform public.assert_car_chain(v_offer.car_id, v_offer.week_start);

    update public.requests set status = 'assigned', status_reason = 'FREED_SLOT_AUTO' where id = (v_first ->> 'request_id')::uuid;
    update public.freed_slot_offers set status = 'auto_assigned', resolved_at = now(),
      winning_request_id = (v_first ->> 'request_id')::uuid
    where id = p_offer_id;

    perform public.enqueue_notification((v_first ->> 'requester_id')::uuid, 'freed_slot_auto', v_offer.department_id, v_offer.week_start,
      '{}'::jsonb, jsonb_build_object('ride_id', v_ride_id), format('freed_slot_auto:%s', p_offer_id));
  else
    for v_cand in select * from jsonb_array_elements(p_ranked_candidates) loop
      insert into public.freed_slot_claims (offer_id, request_id, profile_id, status, offered_at)
      values (p_offer_id, (v_cand ->> 'request_id')::uuid, (v_cand ->> 'requester_id')::uuid, 'offered', now())
      on conflict (offer_id, request_id) do nothing;
      perform public.enqueue_notification((v_cand ->> 'requester_id')::uuid, 'freed_slot', v_offer.department_id, v_offer.week_start,
        '{}'::jsonb, jsonb_build_object('offer_id', p_offer_id),
        format('freed_slot:%s:%s', p_offer_id, v_cand ->> 'request_id'));
    end loop;
    update public.freed_slot_offers set status = 'pending_approval' where id = p_offer_id;
    perform public.enqueue_notification(s.profile_id, 'claim_contested', v_offer.department_id, v_offer.week_start,
      jsonb_build_object('count', v_count::text), jsonb_build_object('offer_id', p_offer_id), format('claim_contested:%s', p_offer_id))
    from public.sadranim_of(v_offer.department_id, v_offer.week_start) as s(profile_id);
  end if;
end;
$$;

revoke execute on function public.resolve_freed_offer(uuid, jsonb) from public, anon;
grant execute on function public.resolve_freed_offer(uuid, jsonb) to authenticated;

create or replace function public.claim_freed_slot(p_offer_id uuid, p_request_id uuid) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
begin
  if not exists (select 1 from public.requests where id = p_request_id and requester_id = (select auth.uid())) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  perform set_config('app.audit_reason', 'claim_freed_slot', true);
  update public.freed_slot_claims set status = 'claimed', claimed_at = now()
  where offer_id = p_offer_id and request_id = p_request_id and status = 'offered';
end;
$$;

revoke execute on function public.claim_freed_slot(uuid, uuid) from public, anon;
grant execute on function public.claim_freed_slot(uuid, uuid) to authenticated;

create or replace function public.withdraw_freed_slot_claim(p_offer_id uuid, p_request_id uuid) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
begin
  if not exists (select 1 from public.requests where id = p_request_id and requester_id = (select auth.uid())) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  perform set_config('app.audit_reason', 'withdraw_freed_slot_claim', true);
  update public.freed_slot_claims set status = 'withdrawn'
  where offer_id = p_offer_id and request_id = p_request_id and status in ('offered', 'claimed');
end;
$$;

revoke execute on function public.withdraw_freed_slot_claim(uuid, uuid) from public, anon;
grant execute on function public.withdraw_freed_slot_claim(uuid, uuid) to authenticated;

create or replace function public.approve_claim(p_offer_id uuid, p_request_id uuid) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_offer record; v_ride_id uuid;
begin
  select * into v_offer from public.freed_slot_offers where id = p_offer_id;
  if v_offer is null then raise exception 'offer_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_offer.department_id, v_offer.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'approve_claim', true);

  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, is_pinned, pin_reason, created_by)
  select r.department_id, r.week_start, v_offer.car_id, q.depart_at, q.return_at, r.origin_id, r.destination_id,
    q.requester_id, 'confirmed', true, 'FREED_SLOT_APPROVED', (select auth.uid())
  from public.rides r, public.requests q where r.id = v_offer.cancelled_ride_id and q.id = p_request_id
  returning id into v_ride_id;

  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode) values (v_ride_id, p_request_id, 'driver', 'both', 'keep');
  perform public.assert_car_chain(v_offer.car_id, v_offer.week_start);

  update public.freed_slot_claims set status = 'approved', decided_at = now(), decided_by = (select auth.uid())
  where offer_id = p_offer_id and request_id = p_request_id;
  update public.freed_slot_claims set status = 'declined', decided_at = now(), decided_by = (select auth.uid())
  where offer_id = p_offer_id and request_id <> p_request_id and status in ('offered', 'claimed');
  update public.freed_slot_offers set status = 'approved', resolved_at = now(), resolved_by = (select auth.uid()),
    winning_request_id = p_request_id where id = p_offer_id;
  update public.requests set status = 'assigned', status_reason = 'FREED_SLOT_APPROVED' where id = p_request_id;

  perform public.enqueue_notification(q.requester_id, 'claim_approved', v_offer.department_id, v_offer.week_start,
    '{}'::jsonb, jsonb_build_object('ride_id', v_ride_id), format('claim_approved:%s', p_request_id))
  from public.requests q where q.id = p_request_id;
  perform public.enqueue_notification(fc.profile_id, 'claim_declined', v_offer.department_id, v_offer.week_start,
    '{}'::jsonb, jsonb_build_object('offer_id', p_offer_id), format('claim_declined:%s:%s', p_offer_id, fc.profile_id))
  from public.freed_slot_claims fc where fc.offer_id = p_offer_id and fc.request_id <> p_request_id and fc.status = 'declined';

  return v_ride_id;
end;
$$;

revoke execute on function public.approve_claim(uuid, uuid) from public, anon;
grant execute on function public.approve_claim(uuid, uuid) to authenticated;

create or replace function public.close_offer(p_offer_id uuid) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_offer record;
begin
  select * into v_offer from public.freed_slot_offers where id = p_offer_id;
  if v_offer is null then raise exception 'offer_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_offer.department_id, v_offer.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  perform set_config('app.audit_reason', 'close_offer', true);
  update public.freed_slot_offers set status = 'closed', resolved_at = now(), resolved_by = (select auth.uid())
  where id = p_offer_id;
end;
$$;

revoke execute on function public.close_offer(uuid) from public, anon;
grant execute on function public.close_offer(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Admin / misc RPCs
-- ---------------------------------------------------------------------------
create or replace function public.report_car_issue_unsafe_to_maintenance(p_issue_id uuid, p_hours int default 24) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_issue record; v_block_id uuid;
begin
  select * into v_issue from public.car_issues where id = p_issue_id;
  if v_issue is null then raise exception 'car_issue_not_found' using errcode = 'P0001'; end if;
  if not (public.is_admin() or public.is_sadran_any(v_issue.department_id)) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  perform set_config('app.audit_reason', 'report_car_issue_unsafe_to_maintenance', true);
  insert into public.car_maintenance_blocks (car_id, starts_at, ends_at, reason, created_by)
  values (v_issue.car_id, now(), now() + make_interval(hours => p_hours), 'UNSAFE_ISSUE', (select auth.uid()))
  returning id into v_block_id;
  update public.cars set status = 'maintenance' where id = v_issue.car_id;
  return v_block_id;
end;
$$;

revoke execute on function public.report_car_issue_unsafe_to_maintenance(uuid, int) from public, anon;
grant execute on function public.report_car_issue_unsafe_to_maintenance(uuid, int) to authenticated;

create or replace function public.grant_admin(p_profile_id uuid) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
begin
  if not public.is_admin() then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  perform set_config('app.audit_reason', 'grant_admin', true);
  update public.profiles set is_admin = true where id = p_profile_id;
end;
$$;

revoke execute on function public.grant_admin(uuid) from public, anon;
grant execute on function public.grant_admin(uuid) to authenticated;

create or replace function public.suggest_destination(p_name text, p_zone text default 'unknown') returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_id uuid;
begin
  if not public.is_approved() then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  insert into public.destinations (name, zone, is_approved, created_by)
  values (p_name, p_zone, false, (select auth.uid()))
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.suggest_destination(text, text) from public, anon;
grant execute on function public.suggest_destination(text, text) to authenticated;

create or replace function public.create_policy_version(p_policy_id uuid, p_rules jsonb, p_note text default null) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_version_id uuid;
begin
  if not public.is_admin() then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  perform set_config('app.audit_reason', 'create_policy_version', true);
  insert into public.policy_versions (policy_id, rules, note, created_by)
  values (p_policy_id, p_rules, p_note, (select auth.uid()))
  returning id into v_version_id;
  update public.policies set current_version_id = v_version_id where id = p_policy_id;
  return v_version_id;
end;
$$;

revoke execute on function public.create_policy_version(uuid, jsonb, text) from public, anon;
grant execute on function public.create_policy_version(uuid, jsonb, text) to authenticated;

create or replace function public.set_policy_active(p_policy_id uuid, p_is_active boolean) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
begin
  if not public.is_admin() then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  perform set_config('app.audit_reason', 'set_policy_active', true);
  update public.policies set is_active = p_is_active where id = p_policy_id;
end;
$$;

revoke execute on function public.set_policy_active(uuid, boolean) from public, anon;
grant execute on function public.set_policy_active(uuid, boolean) to authenticated;

create or replace function public.register_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_id uuid;
begin
  insert into public.push_subscriptions (profile_id, endpoint, p256dh, auth, user_agent, created_at, last_used_at)
  values ((select auth.uid()), p_endpoint, p_p256dh, p_auth, p_user_agent, now(), now())
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth,
    user_agent = excluded.user_agent, last_used_at = now(), failure_count = 0, profile_id = excluded.profile_id
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.register_push_subscription(text, text, text, text) from public, anon;
grant execute on function public.register_push_subscription(text, text, text, text) to authenticated;

create or replace function public.fairness_stats(p_department_id uuid, p_week_start date, p_lookback_weeks int)
returns table (profile_id uuid, served bigint, served_as_passenger bigint, unmet bigint, external bigint, requested bigint)
security definer set search_path = public, pg_temp
language plpgsql as $$
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  return query
    select p.id,
           count(*) filter (where q.status in ('assigned', 'merged')),
           count(*) filter (where q.status = 'merged'),
           count(*) filter (where q.status in ('denied', 'waitlisted')),
           count(*) filter (where q.status = 'external'),
           count(*)
    from public.department_members dm
    join public.profiles p on p.id = dm.profile_id
    left join public.requests q
      on q.requester_id = p.id and q.department_id = p_department_id
     and q.week_start >= p_week_start - (p_lookback_weeks * 7) and q.week_start < p_week_start
     and q.status in ('assigned', 'merged', 'denied', 'waitlisted', 'external')
    where dm.department_id = p_department_id and dm.removed_at is null
    group by p.id;
end;
$$;

revoke execute on function public.fairness_stats(uuid, date, int) from public, anon;
grant execute on function public.fairness_stats(uuid, date, int) to authenticated;

-- ---------------------------------------------------------------------------
-- materialize_templates: copies active request_templates into newly opened weeks
-- (REQ §12 should-have; called from housekeeping()).
-- ---------------------------------------------------------------------------
create or replace function public.materialize_templates() returns int
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_count int := 0; t record; v_week record; v_depart timestamptz; v_return timestamptz;
begin
  for t in select * from public.request_templates
           where is_active and (paused_until is null or paused_until < current_date)
  loop
    for v_week in select * from public.weeks
                  where department_id = t.department_id and phase = 'open'
                    and (t.last_materialized_week is null or week_start > t.last_materialized_week)
    loop
      v_depart := case when t.depart_dow is not null
        then ((v_week.week_start + t.depart_dow)::timestamp + t.depart_time) at time zone 'Asia/Jerusalem' end;
      v_return := case when t.return_dow is not null
        then ((v_week.week_start + t.return_dow)::timestamp + t.return_time) at time zone 'Asia/Jerusalem' end;

      insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, destination_text,
        ride_type_id, trip_shape, depart_at, return_at, one_way_car_mode, needs_car_at_destination,
        adults, child_seats, boosters, has_luggage,
        flex_depart_early, flex_depart_late, flex_return_early, flex_return_late,
        notes, submitted_at, status, template_id)
      values (t.department_id, v_week.week_start, t.requester_id, t.requester_id, t.destination_id, t.destination_text,
        t.ride_type_id, t.trip_shape, v_depart, v_return, t.one_way_car_mode, t.needs_car_at_destination,
        t.adults, t.child_seats, t.boosters, t.has_luggage,
        t.flex_depart_early, t.flex_depart_late, t.flex_return_early, t.flex_return_late,
        t.notes, now(), 'submitted', t.id);

      update public.request_templates set last_materialized_week = v_week.week_start where id = t.id;
      v_count := v_count + 1;
    end loop;
  end loop;
  return v_count;
end;
$$;

revoke execute on function public.materialize_templates() from public, anon;

-- ---------------------------------------------------------------------------
-- Cron sub-functions (called from app.tick(), 20260907091600_cron.sql).
-- ---------------------------------------------------------------------------
create or replace function public.advance_week_phases(p_now timestamptz default now()) returns int
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_count int := 0;
  v_dept record;
  v_settings record;
  v_target date;
  v_open_at timestamptz;
  v_close_at timestamptz;
  v_publish_at timestamptz;
  v_week record;
begin
  for v_dept in select id from public.departments where is_active loop
    select * into v_settings from public.department_settings where department_id = v_dept.id;
    v_target := public.current_week_start() + (v_settings.weeks_open_ahead * 7);
    v_open_at := ((v_target - 7 + v_settings.open_dow)::timestamp + v_settings.open_time) at time zone 'Asia/Jerusalem';

    if p_now >= v_open_at and not exists (
      select 1 from public.weeks w where w.department_id = v_dept.id and w.week_start = v_target
    ) then
      v_close_at := ((v_target - 7 + v_settings.close_dow)::timestamp + v_settings.close_time) at time zone 'Asia/Jerusalem';
      v_publish_at := ((v_target - 7 + v_settings.publish_dow)::timestamp + v_settings.publish_time) at time zone 'Asia/Jerusalem';
      insert into public.weeks (department_id, week_start, phase, open_at, close_at, publish_at)
      values (v_dept.id, v_target, 'open', v_open_at, v_close_at, v_publish_at);

      perform public.enqueue_notification(dm.profile_id, 'window_open', v_dept.id, v_target, '{}'::jsonb, '{}'::jsonb,
        format('window_open:%s:%s', v_dept.id, v_target))
      from public.department_members dm where dm.department_id = v_dept.id and dm.removed_at is null;
      v_count := v_count + 1;
    end if;
  end loop;

  for v_week in select * from public.weeks where phase = 'open' and close_at <= p_now loop
    update public.weeks set phase = 'solving' where department_id = v_week.department_id and week_start = v_week.week_start;
    perform public.enqueue_notification(s.profile_id, 'window_closed_solve_now', v_week.department_id, v_week.week_start,
      '{}'::jsonb, '{}'::jsonb, format('window_closed_solve_now:%s:%s', v_week.department_id, v_week.week_start))
    from public.sadranim_of(v_week.department_id, v_week.week_start) as s(profile_id);
    v_count := v_count + 1;
  end loop;

  update public.weeks set phase = 'archived'
  where phase in ('published', 'live') and (week_start + 7) <= (p_now at time zone 'Asia/Jerusalem')::date;

  update public.weeks set phase = 'live'
  where phase = 'published' and week_start <= public.current_week_start();

  return v_count;
end;
$$;

revoke execute on function public.advance_week_phases(timestamptz) from public, anon;

create or replace function public.send_due_reminders(p_now timestamptz default now()) returns int
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_count int := 0; v_week record; v_settings record; v_hours int;
begin
  for v_week in select * from public.weeks where phase = 'open' loop
    select * into v_settings from public.department_settings where department_id = v_week.department_id;
    foreach v_hours in array v_settings.closing_reminder_hours loop
      if p_now >= v_week.close_at - make_interval(hours => v_hours)
         and p_now < v_week.close_at - make_interval(hours => v_hours) + interval '15 min' then
        perform public.enqueue_notification(dm.profile_id, 'window_closing', v_week.department_id, v_week.week_start,
          jsonb_build_object('count', v_hours::text), '{}'::jsonb,
          format('window_closing:%s:%s:%s', v_week.department_id, v_week.week_start, v_hours))
        from public.department_members dm
        where dm.department_id = v_week.department_id and dm.removed_at is null
          and not exists (
            select 1 from public.requests q where q.department_id = v_week.department_id and q.week_start = v_week.week_start
              and q.requester_id = dm.profile_id and q.status <> 'withdrawn'
          );
        v_count := v_count + 1;
      end if;
    end loop;
  end loop;

  for v_week in select * from public.weeks where phase = 'solving' and publish_reminder_sent_at is null loop
    select * into v_settings from public.department_settings where department_id = v_week.department_id;
    if p_now >= ((v_week.week_start - 7 + v_settings.publish_dow)::timestamp + v_settings.publish_time) at time zone 'Asia/Jerusalem' then
      perform public.enqueue_notification(s.profile_id, 'publish_reminder', v_week.department_id, v_week.week_start,
        '{}'::jsonb, '{}'::jsonb, format('publish_reminder:%s:%s', v_week.department_id, v_week.week_start))
      from public.sadranim_of(v_week.department_id, v_week.week_start) as s(profile_id);
      update public.weeks set publish_reminder_sent_at = p_now
      where department_id = v_week.department_id and week_start = v_week.week_start;
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.send_due_reminders(timestamptz) from public, anon;

-- Daily prunes per DATA_MODEL §8 retention table; every tick closes stale freed-slot offers
-- and materializes templates once per local day; the 03:00-local pass does the deletes.
create or replace function public.housekeeping(p_now timestamptz default now()) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_hour int; v_last_prune date;
begin
  perform public.expire_freed_offers(p_now);

  v_hour := extract(hour from (p_now at time zone 'Asia/Jerusalem'));
  select (value ->> 'value')::date into v_last_prune from public.app_settings where key = 'housekeeping_last_run';

  if v_last_prune is null or v_last_prune < (p_now at time zone 'Asia/Jerusalem')::date then
    perform public.materialize_templates();

    if v_hour >= 3 then
      delete from public.notifications where created_at < p_now - interval '90 days';
      delete from public.push_outbox where status in ('sent', 'dead') and created_at < p_now - interval '30 days';
      delete from public.client_errors where created_at < p_now - interval '90 days';
      delete from public.push_subscriptions where last_used_at < p_now - interval '180 days';
      -- token_hash cannot be null (unique not-null column); scramble it instead so old links die.
      update public.proposals set token_hash = encode(digest(gen_random_uuid()::text, 'sha256'), 'hex')
      where expires_at < p_now - interval '30 days' and status in ('expired', 'withdrawn', 'applied', 'declined');
      delete from public.audit_log where at < p_now - interval '1 year'
        and table_name not in ('requests', 'rides', 'proposals', 'policies', 'weeks', 'siddur_versions');
      delete from public.audit_log where at < p_now - interval '3 years';
      delete from public.request_templates where not is_active and updated_at < p_now - interval '1 year';

      insert into public.app_settings (key, value, updated_at)
      values ('housekeeping_last_run', to_jsonb((p_now at time zone 'Asia/Jerusalem')::date::text), p_now)
      on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
    end if;
  end if;
end;
$$;

revoke execute on function public.housekeeping(timestamptz) from public, anon;
