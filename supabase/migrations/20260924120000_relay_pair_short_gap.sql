-- Owner decision 2026-09-24 (docs/TODO.md Code review Q5; REQUIREMENTS §13.88): two opposite
-- one-way legs at the same X pair into a relay even when the gap at X is shorter than the
-- turnaround — the car just waits there. Only a true overlap prevents pairing. The out-leg
-- stores the actual gap as `turnaround_override_minutes`, so rides_before_write() accepts the
-- tight pair while every other neighbour keeps the full buffer.
--   * pair_one_way_legs(): pairs any non-overlapping gap; sets the out-leg's override when the
--     gap is shorter than the turnaround (null otherwise).
--   * apply_solver_result(): stores the solver's `turnaround_override_minutes` for such out-legs
--     (src/solver `Assignment.turnaroundAfterMinutes`).
--   * try_widen_one_way_leg(): a leg reshaped into a chauffeur ride drops any override.
--   * pair_one_way_legs() (owner 2026-09-24, Q8): the car both legs move onto must fit each
--     leg's own seats (car_fits); otherwise the legs stay separate chauffeur rides.
--   * pair_one_way_legs() restores the caller's `app.system_status_transition` value instead of
--     forcing it off; reserve_live_one_way_slot() reports a leg its chain check just paired as
--     `assigned`/RELAY_PAIRED instead of overwriting it to waitlisted/UNMET_NEEDS_DRIVER.
--   * assert_car_chain(): a next ride starting exactly when the previous one ends (a 0-minute
--     relay gap) counts as the car's next ride, so the out-leg is not widened back.
-- Full `create or replace` of each (R10 convention), otherwise identical to schema-current.sql.

CREATE OR REPLACE FUNCTION "public"."apply_solver_result"("p_department_id" "uuid", "p_week_start" "date", "p_payload" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
  v_doomed_rides uuid[] := '{}';
  v_prop_id uuid;
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

    -- REQ §13.90: a proposal referencing one of these about-to-be-deleted rides must
    -- never leave a dangling FK. Pending ones are withdrawn (the request's own
    -- previous_status is restored by proposals_status_guard); answered/applied ones keep
    -- their row for history with the ride link detached.
    select coalesce(array_agg(id), '{}') into v_doomed_rides
    from public.rides
    where department_id = p_department_id and week_start = p_week_start and status = 'draft' and not is_pinned;

    for v_prop_id in
      select id from public.proposals where status in ('draft', 'sent') and ride_id = any(v_doomed_rides)
      for update
    loop
      update public.proposals set status = 'withdrawn' where id = v_prop_id;
    end loop;
    -- Every reference to a doomed ride must be cleared regardless of status — the FK has
    -- no `on delete`, so a stale ride_id (even on a row just withdrawn above) would still
    -- block the delete below.
    update public.proposals set ride_id = null where ride_id = any(v_doomed_rides);
    update public.proposals set applied_ride_id = null where applied_ride_id = any(v_doomed_rides);

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
      driver_id, status, is_pinned, pin_reason, created_by_solver_run_id, created_by, overflow_allowed, series_id,
      needs_driver, auto_relocation, turnaround_override_minutes)
    values (p_department_id, p_week_start, (v_ride ->> 'car_id')::uuid,
      (v_ride ->> 'starts_at')::timestamptz, (v_ride ->> 'ends_at')::timestamptz,
      (v_ride ->> 'origin_id')::uuid, (v_ride ->> 'destination_id')::uuid,
      nullif(v_ride ->> 'driver_id', '')::uuid, 'draft',
      coalesce((v_ride ->> 'is_pinned')::boolean, false), v_ride ->> 'pin_reason',
      v_run_id, (select auth.uid()), coalesce((v_ride ->> 'overflow_allowed')::boolean, false), v_series_id,
      nullif(v_ride ->> 'driver_id', '') is null, coalesce((v_ride ->> 'auto_relocation')::boolean, false),
      -- Out-leg of a relay pair with less than the turnaround at X (REQ §13.88, owner 2026-09-24).
      (v_ride ->> 'turnaround_override_minutes')::smallint)
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
    where id = (v_status ->> 'request_id')::uuid
      and department_id = p_department_id and week_start = p_week_start;

    if found and (v_status ->> 'status') = 'waitlisted' then
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
$$;


ALTER FUNCTION "public"."apply_solver_result"("p_department_id" "uuid", "p_week_start" "date", "p_payload" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."approve_claim"("p_offer_id" "uuid", "p_request_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."approve_claim"("p_offer_id" "uuid", "p_request_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assert_car_chain"("_car" "uuid", "_week" "date") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_home uuid; v_day_end time; v_loc uuid; v_car_name text; v_dept uuid; v_week_starts timestamptz;
  v_new_status public.ride_status; v_turnaround interval; v_pending uuid[]; v_hint jsonb; v_hint_used boolean := false;
  r record; v_gap_id uuid; v_travel interval; v_start timestamptz; v_end timestamptz; v_next_start_limit timestamptz;
  v_widen text; v_r_origin uuid; v_r_destination uuid;
begin
  select d.id, d.home_destination_id, s.day_end_time, c.name into v_dept, v_home, v_day_end, v_car_name
  from public.cars c
  join public.departments d on d.id = c.department_id
  join public.department_settings s on s.department_id = d.id
  where c.id = _car;
  if v_home is null then raise exception 'no_home_location' using errcode = 'P0412'; end if;

  v_hint := nullif(current_setting('app.chain_hint', true), '')::jsonb;
  perform set_config('app.chain_hint', '', true);

  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(v_dept, _week), 30));
  v_new_status := case when public.is_week_public(v_dept, _week) then 'confirmed'::public.ride_status else 'draft'::public.ride_status end;

  -- REQ §13.88/§13.89: pair up any matching one-way legs across the department before
  -- walking this car's own chain, so a freshly-matched pair is never seen as a gap.
  perform public.pair_one_way_legs(v_dept, _week);

  select coalesce(array_agg(id order by starts_at), '{}') into v_pending
  from public.rides
  where car_id = _car and week_start = _week and auto_relocation and needs_driver
    and driver_id is null and status <> 'cancelled' and not planning_conflict;

  v_week_starts := (_week::timestamp) at time zone 'Asia/Jerusalem';
  select coalesce((select p.destination_id from public.rides p
                   where p.car_id = _car and p.status <> 'cancelled' and not p.planning_conflict
                     and (not p.auto_relocation or p.driver_id is not null)
                     and p.starts_at < v_week_starts
                   order by p.starts_at desc limit 1), v_home)
    into v_loc;

  for r in
    select id, origin_id, destination_id, starts_at, ends_at, blocked_until, overnight_ack_by, series_id, created_by
    from public.rides
    where car_id = _car and week_start = _week and status <> 'cancelled' and not planning_conflict
      and (not auto_relocation or driver_id is not null)
    order by starts_at
  loop
    v_r_origin := r.origin_id;
    v_r_destination := r.destination_id;

    if v_r_origin <> v_loc then
      -- Out-gap: the car must relocate v_loc -> r.origin_id before r can start. A lone
      -- one-way "return" leg fetches itself instead of a separate relocation ride.
      v_widen := null;
      if v_loc = v_home then
        v_widen := public.try_widen_one_way_leg(r.id, _car, v_dept, _week, v_home, v_turnaround, 'fetch');
      end if;
      if v_widen = 'here' then
        v_r_origin := v_home;
      elsif v_widen = 'moved' then
        -- The leg moved to another car entirely; it no longer belongs to this car's chain.
        continue;
      else
        select id into v_gap_id from public.rides where id = any(v_pending)
          and origin_id = v_loc and destination_id = r.origin_id order by starts_at limit 1;
        if v_gap_id is not null then
          v_pending := array_remove(v_pending, v_gap_id);
        else
          v_travel := make_interval(mins => greatest(coalesce((select travel_minutes from public.destinations
            where id = case when v_loc = v_home then r.origin_id else v_loc end), 30), 15));
          if not v_hint_used and v_hint is not null
            and (v_hint->>'origin_id')::uuid = v_loc and (v_hint->>'destination_id')::uuid = r.origin_id
            and (v_hint->>'ends_at')::timestamptz <= r.starts_at - v_turnaround
          then
            v_start := (v_hint->>'starts_at')::timestamptz;
            v_end := (v_hint->>'ends_at')::timestamptz;
            v_hint_used := true;
          else
            v_end := r.starts_at - v_turnaround;
            if not public.is_quarter_hour(v_end) then
              v_end := to_timestamp(floor(extract(epoch from v_end) / 900) * 900);
            end if;
            v_start := v_end - v_travel;
            if not public.is_quarter_hour(v_start) then
              v_start := to_timestamp(floor(extract(epoch from v_start) / 900) * 900);
            end if;
            if v_start >= v_end then v_start := v_end - interval '15 minutes'; end if;
          end if;
          insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
            driver_id, needs_driver, auto_relocation, status, is_pinned, created_by)
          values(v_dept, _week, _car, v_start, v_end, v_loc, r.origin_id, null, true, true, v_new_status, false,
            coalesce((select auth.uid()), r.created_by));
        end if;
      end if;
    end if;
    v_loc := v_r_destination;

    if v_r_destination <> v_home and r.overnight_ack_by is null
      -- REQ §13.77: the next leg of the same series takes the car over the night.
      and not (r.series_id is not null and exists (
        select 1 from public.rides s
        where s.car_id = _car and s.status <> 'cancelled' and not s.planning_conflict
          and s.series_id = r.series_id and s.id <> r.id
          and (s.starts_at at time zone 'Asia/Jerusalem')::date
              = (r.ends_at at time zone 'Asia/Jerusalem')::date + 1))
    then
      v_next_start_limit := (((r.ends_at at time zone 'Asia/Jerusalem')::date + v_day_end) at time zone 'Asia/Jerusalem');
      if not exists (
        select 1 from public.rides n
        where n.car_id = _car and n.status <> 'cancelled' and not n.planning_conflict
          and (not n.auto_relocation or n.driver_id is not null)
          and n.starts_at > r.ends_at and n.starts_at < v_next_start_limit
      ) then
        -- Return-relocation gap: r.destination_id -> home, by day end. A lone one-way
        -- "out" leg widens into home -> X -> home instead of a separate relocation ride.
        v_widen := public.try_widen_one_way_leg(r.id, _car, v_dept, _week, v_home, v_turnaround, 'out');
        if v_widen = 'here' then
          v_loc := v_home;
        elsif v_widen = 'moved' then
          v_loc := v_home; -- the leg (and its away-gap) moved to another car entirely.
        else
          select id into v_gap_id from public.rides where id = any(v_pending)
            and origin_id = r.destination_id and destination_id = v_home
            and starts_at >= r.blocked_until order by starts_at limit 1;
          if v_gap_id is not null then
            v_pending := array_remove(v_pending, v_gap_id);
          else
            v_travel := make_interval(mins => greatest(coalesce((select travel_minutes from public.destinations
              where id = r.destination_id), 30), 15));
            if not v_hint_used and v_hint is not null
              and (v_hint->>'origin_id')::uuid = r.destination_id and (v_hint->>'destination_id')::uuid = v_home
              and (v_hint->>'starts_at')::timestamptz >= r.blocked_until
            then
              v_start := (v_hint->>'starts_at')::timestamptz;
              v_end := (v_hint->>'ends_at')::timestamptz;
              v_hint_used := true;
            else
              v_end := v_next_start_limit;
              if not (public.is_quarter_hour(v_end) or public.is_same_day_end(v_end)) then
                v_end := to_timestamp(floor(extract(epoch from v_end) / 900) * 900);
              end if;
              v_start := v_end - v_travel;
              if not public.is_quarter_hour(v_start) then
                v_start := to_timestamp(floor(extract(epoch from v_start) / 900) * 900);
              end if;
              if v_start < r.blocked_until then
                -- Would overlap the last real ride's own turnaround: place right after it.
                v_start := r.blocked_until;
                if not public.is_quarter_hour(v_start) then
                  v_start := to_timestamp(ceil(extract(epoch from v_start) / 900) * 900);
                end if;
                v_end := v_start + v_travel;
                if not (public.is_quarter_hour(v_end) or public.is_same_day_end(v_end)) then
                  v_end := to_timestamp(ceil(extract(epoch from v_end) / 900) * 900);
                end if;
              end if;
              if v_start >= v_end then v_end := v_start + interval '15 minutes'; end if;
            end if;
            insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
              driver_id, needs_driver, auto_relocation, status, is_pinned, created_by)
            values(v_dept, _week, _car, v_start, v_end, r.destination_id, v_home, null, true, true, v_new_status, false,
              coalesce((select auth.uid()), r.created_by));
          end if;
          v_loc := v_home;
        end if;
      end if;
    end if;
  end loop;

  -- Any tentative relocation not reused above is no longer needed (a real ride now
  -- bridges the gap, or the car is already where it would have brought it).
  if coalesce(array_length(v_pending, 1), 0) > 0 then
    update public.rides set status = 'cancelled', cancelled_at = now(),
      cancelled_by = coalesce((select auth.uid()), created_by), cancel_reason = 'AUTO_RELOCATION_OBSOLETE'
    where id = any(v_pending);
  end if;
end $$;

CREATE OR REPLACE FUNCTION "public"."pair_one_way_legs"("p_dept" "uuid", "p_week" "date") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_home uuid; v_turnaround interval; v_travel int;
  out_leg record; ret_leg record;
  v_driver_out uuid; v_driver_ret uuid;
  v_out_start timestamptz; v_out_end timestamptz; v_ret_start timestamptz; v_ret_end timestamptz;
  v_target_car uuid;
  v_gap_override smallint;
  v_out_load record; v_ret_load record;
  v_prev_flag text;
begin
  select d.home_destination_id into v_home from public.departments d where d.id = p_dept;
  if v_home is null then return; end if;
  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(p_dept, p_week), 30));

  for out_leg in
    select r.id as ride_id, r.car_id, r.driver_id, r.needs_driver,
           rr.request_id, q.destination_id, q.depart_at
    from public.rides r
    join public.ride_requests rr on rr.ride_id = r.id
    join public.requests q on q.id = rr.request_id
    where r.department_id = p_dept and r.week_start = p_week and r.status <> 'cancelled' and not r.planning_conflict
      and not r.auto_relocation and r.overnight_ack_by is null
      and q.trip_shape = 'one_way_to'
      and (select count(*) from public.ride_requests rr2 where rr2.ride_id = r.id) = 1
    order by r.starts_at
  loop
    v_travel := greatest(coalesce((select travel_minutes from public.destinations where id = out_leg.destination_id), 30), 0);
    v_out_start := out_leg.depart_at;
    v_out_end := v_out_start + make_interval(mins => v_travel);
    if not public.is_quarter_hour(v_out_end) then
      v_out_end := to_timestamp(ceil(extract(epoch from v_out_end) / 900) * 900);
    end if;

    select r2.id as ride_id, r2.car_id, rr2.request_id, q2.return_at
      into ret_leg
    from public.rides r2
    join public.ride_requests rr2 on rr2.ride_id = r2.id
    join public.requests q2 on q2.id = rr2.request_id
    where r2.department_id = p_dept and r2.week_start = p_week and r2.status <> 'cancelled' and not r2.planning_conflict
      and not r2.auto_relocation and r2.overnight_ack_by is null
      and q2.trip_shape = 'one_way_from' and q2.destination_id = out_leg.destination_id
      and (select count(*) from public.ride_requests rr3 where rr3.ride_id = r2.id) = 1
      -- REQ §13.88 (owner 2026-09-24): any non-overlapping gap at X pairs, even one shorter
      -- than the turnaround — the car just waits there; the out-leg stores the actual gap.
      and q2.return_at - make_interval(mins => v_travel) >= v_out_end
    order by q2.return_at limit 1;

    if ret_leg.ride_id is null then continue; end if;

    v_driver_out := public.eligible_leg_driver(out_leg.request_id);
    v_driver_ret := public.eligible_leg_driver(ret_leg.request_id);
    if v_driver_out is null or v_driver_ret is null then continue; end if;

    -- Idempotent: already paired correctly (out-leg already relay with the right driver,
    -- on the same car as the return leg) — nothing to do.
    if out_leg.needs_driver = false and out_leg.driver_id = v_driver_out and out_leg.car_id = ret_leg.car_id then
      continue;
    end if;

    v_ret_start := ret_leg.return_at - make_interval(mins => v_travel);
    if not public.is_quarter_hour(v_ret_start) then
      v_ret_start := to_timestamp(floor(extract(epoch from v_ret_start) / 900) * 900);
    end if;
    v_ret_end := ret_leg.return_at;
    v_gap_override := case when v_ret_start - v_out_end < v_turnaround
      then (extract(epoch from (v_ret_start - v_out_end)) / 60)::smallint end;

    -- Owner 2026-09-24 (docs/TODO.md Q8): both legs end up on one car, so each leg's own load
    -- must fit it (the deferred ride_seat_fit_on_car_change trigger would otherwise fail the
    -- caller's whole transaction at commit). No fitting, free car → keep the separate chauffeur rides.
    select adults, child_seats, boosters into v_out_load from public.requests where id = out_leg.request_id;
    select adults, child_seats, boosters into v_ret_load from public.requests where id = ret_leg.request_id;
    v_target_car := null;
    if out_leg.car_id = ret_leg.car_id then
      v_target_car := out_leg.car_id;
    elsif public.car_fits(out_leg.car_id, v_out_load.adults, v_out_load.child_seats, v_out_load.boosters)
      and public.car_fits(out_leg.car_id, v_ret_load.adults, v_ret_load.child_seats, v_ret_load.boosters)
      and not exists (
        select 1 from public.rides x where x.car_id = out_leg.car_id and x.id not in (out_leg.ride_id, ret_leg.ride_id)
          and x.status <> 'cancelled' and not x.planning_conflict
          and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_ret_start, v_ret_end + v_turnaround, '[)'))
    then
      v_target_car := out_leg.car_id;
    elsif public.car_fits(ret_leg.car_id, v_out_load.adults, v_out_load.child_seats, v_out_load.boosters)
      and public.car_fits(ret_leg.car_id, v_ret_load.adults, v_ret_load.child_seats, v_ret_load.boosters)
      and not exists (
        select 1 from public.rides x where x.car_id = ret_leg.car_id and x.id not in (out_leg.ride_id, ret_leg.ride_id)
          and x.status <> 'cancelled' and not x.planning_conflict
          and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_out_start, v_out_end + v_turnaround, '[)'))
    then
      v_target_car := ret_leg.car_id;
    end if;
    if v_target_car is null then
      continue; -- no car is free for, and fits, both legs; heal each independently for now
    end if;

    update public.rides set car_id = v_target_car, origin_id = v_home, destination_id = out_leg.destination_id,
      starts_at = v_out_start, ends_at = v_out_end, needs_driver = false, driver_id = v_driver_out,
      turnaround_override_minutes = v_gap_override
    where id = out_leg.ride_id;
    update public.ride_requests set role = 'driver', car_mode = 'relay'
    where ride_id = out_leg.ride_id and request_id = out_leg.request_id;

    update public.rides set car_id = v_target_car, origin_id = out_leg.destination_id, destination_id = v_home,
      starts_at = v_ret_start, ends_at = v_ret_end, needs_driver = false, driver_id = v_driver_ret
    where id = ret_leg.ride_id;
    update public.ride_requests set role = 'driver', car_mode = 'relay'
    where ride_id = ret_leg.ride_id and request_id = ret_leg.request_id;

    -- A leg created as a lone chauffeur reservation (needs_driver, REQ §8) marks its
    -- request 'waitlisted'/UNMET_NEEDS_DRIVER; now that it is an ordinary driven relay
    -- leg, the request is assigned like any other driver placement.
    -- Restore the caller's flag instead of forcing 'off' (a caller such as
    -- reserve_live_one_way_slot() still has system status writes to make after this).
    v_prev_flag := coalesce(current_setting('app.system_status_transition', true), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'assigned', status_reason = 'RELAY_PAIRED'
    where id in (out_leg.request_id, ret_leg.request_id) and status is distinct from 'assigned';
    perform set_config('app.system_status_transition', v_prev_flag, true);
  end loop;
end $$;

CREATE OR REPLACE FUNCTION "public"."try_widen_one_way_leg"("p_ride_id" "uuid", "p_car" "uuid", "p_dept" "uuid", "p_week" "date", "p_home" "uuid", "p_turnaround" interval, "p_direction" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ride public.rides%rowtype;
  v_request_id uuid; v_trip_shape public.trip_shape; v_dest uuid;
  v_travel int; v_dwell int; v_start timestamptz; v_end timestamptz;
  v_car_id uuid; v_candidate uuid;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride is null or v_ride.status = 'cancelled' or v_ride.overnight_ack_by is not null then return null; end if;
  if (select count(*) from public.ride_requests where ride_id = p_ride_id) <> 1 then return null; end if;

  select rr.request_id, q.trip_shape, q.destination_id into v_request_id, v_trip_shape, v_dest
  from public.ride_requests rr join public.requests q on q.id = rr.request_id
  where rr.ride_id = p_ride_id;
  if v_trip_shape = 'round_trip' then return null; end if;
  if p_direction = 'out' and v_trip_shape <> 'one_way_to' then return null; end if;
  if p_direction = 'fetch' and v_trip_shape <> 'one_way_from' then return null; end if;

  select coalesce(
      (select (w.settings_overrides ->> 'chauffeur_dwell_minutes')::int from public.weeks w
       where w.department_id = p_dept and w.week_start = p_week),
      (select s.chauffeur_dwell_minutes from public.department_settings s where s.department_id = p_dept), 10)
    into v_dwell;
  select greatest(coalesce(travel_minutes, 30), 0) into v_travel from public.destinations where id = v_dest;

  if p_direction = 'out' then
    -- Out-leg widening: the car leaves at the same time it already would, and comes
    -- straight back instead of being left at X.
    v_start := v_ride.starts_at;
    v_end := v_start + make_interval(mins => 2 * v_travel + greatest(v_dwell, 0));
    if not (public.is_quarter_hour(v_end) or public.is_same_day_end(v_end)) then
      v_end := to_timestamp(ceil(extract(epoch from v_end) / 900) * 900);
    end if;
  else
    -- Fetch widening: the car arrives home at the same time it already would (the
    -- requested arrival), leaving earlier to go fetch the passenger first.
    v_end := v_ride.ends_at;
    v_start := v_end - make_interval(mins => 2 * v_travel + greatest(v_dwell, 0));
    if not public.is_quarter_hour(v_start) then
      v_start := to_timestamp(floor(extract(epoch from v_start) / 900) * 900);
    end if;
  end if;
  if v_start >= v_end then v_end := v_start + interval '15 minutes'; end if;

  v_car_id := p_car;
  if exists (
    select 1 from public.rides x
    where x.car_id = v_car_id and x.id <> p_ride_id and x.status <> 'cancelled' and not x.planning_conflict
      and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_start, v_end + p_turnaround, '[)')
  ) then
    v_car_id := null;
    for v_candidate in
      select c.id from public.cars c
      where c.department_id = p_dept and c.status = 'active' and c.type = 'shared' and c.id <> p_car
      order by c.id
    loop
      if not exists (
        select 1 from public.rides x
        where x.car_id = v_candidate and x.status <> 'cancelled' and not x.planning_conflict
          and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_start, v_end + p_turnaround, '[)')
      ) then
        v_car_id := v_candidate;
        exit;
      end if;
    end loop;
    if v_car_id is null then return null; end if;
  end if;

  update public.rides set
    car_id = v_car_id, origin_id = p_home, destination_id = p_home,
    starts_at = v_start, ends_at = v_end, needs_driver = true, driver_id = null,
    -- A former relay out-leg may carry its short gap at X as an override (20260924120000);
    -- the reshaped chauffeur ride gets the ordinary turnaround again.
    turnaround_override_minutes = null
  where id = p_ride_id;

  update public.ride_requests set role = 'passenger', car_mode = 'chauffeur'
  where ride_id = p_ride_id and request_id = v_request_id;

  return case when v_car_id = p_car then 'here' else 'moved' end;
end $$;

CREATE OR REPLACE FUNCTION "public"."assert_car_chain"("_car" "uuid", "_week" "date") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_home uuid; v_day_end time; v_loc uuid; v_car_name text; v_dept uuid; v_week_starts timestamptz;
  v_new_status public.ride_status; v_turnaround interval; v_pending uuid[]; v_hint jsonb; v_hint_used boolean := false;
  r record; v_gap_id uuid; v_travel interval; v_start timestamptz; v_end timestamptz; v_next_start_limit timestamptz;
  v_widen text; v_r_origin uuid; v_r_destination uuid;
begin
  select d.id, d.home_destination_id, s.day_end_time, c.name into v_dept, v_home, v_day_end, v_car_name
  from public.cars c
  join public.departments d on d.id = c.department_id
  join public.department_settings s on s.department_id = d.id
  where c.id = _car;
  if v_home is null then raise exception 'no_home_location' using errcode = 'P0412'; end if;

  v_hint := nullif(current_setting('app.chain_hint', true), '')::jsonb;
  perform set_config('app.chain_hint', '', true);

  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(v_dept, _week), 30));
  v_new_status := case when public.is_week_public(v_dept, _week) then 'confirmed'::public.ride_status else 'draft'::public.ride_status end;

  -- REQ §13.88/§13.89: pair up any matching one-way legs across the department before
  -- walking this car's own chain, so a freshly-matched pair is never seen as a gap.
  perform public.pair_one_way_legs(v_dept, _week);

  select coalesce(array_agg(id order by starts_at), '{}') into v_pending
  from public.rides
  where car_id = _car and week_start = _week and auto_relocation and needs_driver
    and driver_id is null and status <> 'cancelled' and not planning_conflict;

  v_week_starts := (_week::timestamp) at time zone 'Asia/Jerusalem';
  select coalesce((select p.destination_id from public.rides p
                   where p.car_id = _car and p.status <> 'cancelled' and not p.planning_conflict
                     and (not p.auto_relocation or p.driver_id is not null)
                     and p.starts_at < v_week_starts
                   order by p.starts_at desc limit 1), v_home)
    into v_loc;

  for r in
    select id, origin_id, destination_id, starts_at, ends_at, blocked_until, overnight_ack_by, series_id, created_by
    from public.rides
    where car_id = _car and week_start = _week and status <> 'cancelled' and not planning_conflict
      and (not auto_relocation or driver_id is not null)
    order by starts_at
  loop
    v_r_origin := r.origin_id;
    v_r_destination := r.destination_id;

    if v_r_origin <> v_loc then
      -- Out-gap: the car must relocate v_loc -> r.origin_id before r can start. A lone
      -- one-way "return" leg fetches itself instead of a separate relocation ride.
      v_widen := null;
      if v_loc = v_home then
        v_widen := public.try_widen_one_way_leg(r.id, _car, v_dept, _week, v_home, v_turnaround, 'fetch');
      end if;
      if v_widen = 'here' then
        v_r_origin := v_home;
      elsif v_widen = 'moved' then
        -- The leg moved to another car entirely; it no longer belongs to this car's chain.
        continue;
      else
        select id into v_gap_id from public.rides where id = any(v_pending)
          and origin_id = v_loc and destination_id = r.origin_id order by starts_at limit 1;
        if v_gap_id is not null then
          v_pending := array_remove(v_pending, v_gap_id);
        else
          v_travel := make_interval(mins => greatest(coalesce((select travel_minutes from public.destinations
            where id = case when v_loc = v_home then r.origin_id else v_loc end), 30), 15));
          if not v_hint_used and v_hint is not null
            and (v_hint->>'origin_id')::uuid = v_loc and (v_hint->>'destination_id')::uuid = r.origin_id
            and (v_hint->>'ends_at')::timestamptz <= r.starts_at - v_turnaround
          then
            v_start := (v_hint->>'starts_at')::timestamptz;
            v_end := (v_hint->>'ends_at')::timestamptz;
            v_hint_used := true;
          else
            v_end := r.starts_at - v_turnaround;
            if not public.is_quarter_hour(v_end) then
              v_end := to_timestamp(floor(extract(epoch from v_end) / 900) * 900);
            end if;
            v_start := v_end - v_travel;
            if not public.is_quarter_hour(v_start) then
              v_start := to_timestamp(floor(extract(epoch from v_start) / 900) * 900);
            end if;
            if v_start >= v_end then v_start := v_end - interval '15 minutes'; end if;
          end if;
          insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
            driver_id, needs_driver, auto_relocation, status, is_pinned, created_by)
          values(v_dept, _week, _car, v_start, v_end, v_loc, r.origin_id, null, true, true, v_new_status, false,
            coalesce((select auth.uid()), r.created_by));
        end if;
      end if;
    end if;
    v_loc := v_r_destination;

    if v_r_destination <> v_home and r.overnight_ack_by is null
      -- REQ §13.77: the next leg of the same series takes the car over the night.
      and not (r.series_id is not null and exists (
        select 1 from public.rides s
        where s.car_id = _car and s.status <> 'cancelled' and not s.planning_conflict
          and s.series_id = r.series_id and s.id <> r.id
          and (s.starts_at at time zone 'Asia/Jerusalem')::date
              = (r.ends_at at time zone 'Asia/Jerusalem')::date + 1))
    then
      v_next_start_limit := (((r.ends_at at time zone 'Asia/Jerusalem')::date + v_day_end) at time zone 'Asia/Jerusalem');
      if not exists (
        select 1 from public.rides n
        where n.car_id = _car and n.status <> 'cancelled' and not n.planning_conflict
          and (not n.auto_relocation or n.driver_id is not null)
          -- `>=`: a relay return leg may start the moment the out-leg arrives (REQ §13.88,
          -- owner 2026-09-24 — no buffer inside a pair); it is still the car's next ride.
          and n.id <> r.id and n.starts_at >= r.ends_at and n.starts_at < v_next_start_limit
      ) then
        -- Return-relocation gap: r.destination_id -> home, by day end. A lone one-way
        -- "out" leg widens into home -> X -> home instead of a separate relocation ride.
        v_widen := public.try_widen_one_way_leg(r.id, _car, v_dept, _week, v_home, v_turnaround, 'out');
        if v_widen = 'here' then
          v_loc := v_home;
        elsif v_widen = 'moved' then
          v_loc := v_home; -- the leg (and its away-gap) moved to another car entirely.
        else
          select id into v_gap_id from public.rides where id = any(v_pending)
            and origin_id = r.destination_id and destination_id = v_home
            and starts_at >= r.blocked_until order by starts_at limit 1;
          if v_gap_id is not null then
            v_pending := array_remove(v_pending, v_gap_id);
          else
            v_travel := make_interval(mins => greatest(coalesce((select travel_minutes from public.destinations
              where id = r.destination_id), 30), 15));
            if not v_hint_used and v_hint is not null
              and (v_hint->>'origin_id')::uuid = r.destination_id and (v_hint->>'destination_id')::uuid = v_home
              and (v_hint->>'starts_at')::timestamptz >= r.blocked_until
            then
              v_start := (v_hint->>'starts_at')::timestamptz;
              v_end := (v_hint->>'ends_at')::timestamptz;
              v_hint_used := true;
            else
              v_end := v_next_start_limit;
              if not (public.is_quarter_hour(v_end) or public.is_same_day_end(v_end)) then
                v_end := to_timestamp(floor(extract(epoch from v_end) / 900) * 900);
              end if;
              v_start := v_end - v_travel;
              if not public.is_quarter_hour(v_start) then
                v_start := to_timestamp(floor(extract(epoch from v_start) / 900) * 900);
              end if;
              if v_start < r.blocked_until then
                -- Would overlap the last real ride's own turnaround: place right after it.
                v_start := r.blocked_until;
                if not public.is_quarter_hour(v_start) then
                  v_start := to_timestamp(ceil(extract(epoch from v_start) / 900) * 900);
                end if;
                v_end := v_start + v_travel;
                if not (public.is_quarter_hour(v_end) or public.is_same_day_end(v_end)) then
                  v_end := to_timestamp(ceil(extract(epoch from v_end) / 900) * 900);
                end if;
              end if;
              if v_start >= v_end then v_end := v_start + interval '15 minutes'; end if;
            end if;
            insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
              driver_id, needs_driver, auto_relocation, status, is_pinned, created_by)
            values(v_dept, _week, _car, v_start, v_end, r.destination_id, v_home, null, true, true, v_new_status, false,
              coalesce((select auth.uid()), r.created_by));
          end if;
          v_loc := v_home;
        end if;
      end if;
    end if;
  end loop;

  -- Any tentative relocation not reused above is no longer needed (a real ride now
  -- bridges the gap, or the car is already where it would have brought it).
  if coalesce(array_length(v_pending, 1), 0) > 0 then
    update public.rides set status = 'cancelled', cancelled_at = now(),
      cancelled_by = coalesce((select auth.uid()), created_by), cancel_reason = 'AUTO_RELOCATION_OBSOLETE'
    where id = any(v_pending);
  end if;
end $$;

CREATE OR REPLACE FUNCTION "public"."reserve_live_one_way_slot"("p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare q public.requests%rowtype; c record; home uuid; duration_minutes int; travel int; dwell int;
  start_time timestamptz;end_time timestamptz;buffer_minutes int;ride_id uuid;
begin
  select * into q from public.requests where id=p_request_id for update;
  if not found or q.requester_id is distinct from (select auth.uid()) or not public.member_of(q.department_id)
    or q.trip_shape='round_trip' or not exists(select 1 from public.weeks where department_id=q.department_id and week_start=q.week_start and phase='live')
    or exists(select 1 from public.ride_requests where request_id=q.id) then raise exception 'invalid_quick_reservation';end if;
  select d.home_destination_id,coalesce((w.settings_overrides->>'chauffeur_dwell_minutes')::int,s.chauffeur_dwell_minutes,10)
    into home,dwell from public.departments d join public.department_settings s on s.department_id=d.id
    join public.weeks w on w.department_id=d.id and w.week_start=q.week_start where d.id=q.department_id;
  select coalesce(travel_minutes,30) into travel from public.destinations where id=q.destination_id;
  travel:=greatest(coalesce(travel,30),0);
  duration_minutes:=greatest(15,ceil((2*travel+greatest(dwell,0))/15.0)::int*15);
  if q.trip_shape='one_way_to' then start_time:=q.depart_at;end_time:=q.depart_at+make_interval(mins=>duration_minutes);
  else end_time:=q.return_at;start_time:=q.return_at-make_interval(mins=>duration_minutes);end if;
  if start_time<now() then raise exception 'ride_in_past';end if;
  if start_time<q.week_start::timestamp at time zone 'Asia/Jerusalem'
    or end_time>(q.week_start+7)::timestamp at time zone 'Asia/Jerusalem' then raise exception 'ride_outside_week';end if;
  if (start_time at time zone 'Asia/Jerusalem')::date<>(coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date then raise exception 'ride_request_day_mismatch';end if;
  buffer_minutes:=coalesce(public.required_turnaround_minutes(q.department_id,q.week_start),30);
  perform set_config('app.audit_reason','reserve_live_one_way_slot',true);
  perform set_config('app.system_status_transition','on',true);
  if home is not null then
    for c in select car.id from public.cars car where car.department_id=q.department_id and car.status='active' and car.type='shared'
      and exists(select 1 from public.car_seat_configs seats where seats.car_id=car.id and seats.adults>=q.adults+1 and seats.child_seats>=q.child_seats and seats.boosters>=q.boosters)
      order by (car.id=q.preferred_car_id) desc nulls last,car.id loop
      -- A car being reserved by another transaction is temporarily unavailable; try the next one.
      if not pg_try_advisory_xact_lock(hashtextextended(c.id::text,0)) then continue;end if;
      perform 1 from public.cars where id=c.id and status='active' and type='shared' for share;
      if not found or public.car_location_at(c.id,start_time) is distinct from home
        or exists(select 1 from public.rides r where r.car_id=c.id and r.status<>'cancelled'
          and tstzrange(r.starts_at,r.blocked_until,'[)') && tstzrange(start_time,end_time+make_interval(mins=>buffer_minutes),'[)'))
        or exists(select 1 from public.car_maintenance_blocks b where b.car_id=c.id
          and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(start_time,end_time+make_interval(mins=>buffer_minutes),'[)')) then continue;end if;
      begin
        insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,needs_driver,status,is_pinned,pin_reason,created_by)
          values(q.department_id,q.week_start,c.id,start_time,end_time,home,home,null,true,'confirmed',true,'MISSING_DRIVER',q.requester_id) returning id into ride_id;
        insert into public.ride_requests(ride_id,request_id,role,leg,car_mode)
          values(ride_id,q.id,'passenger',case when q.trip_shape='one_way_to' then 'out'::public.ride_leg else 'return'::public.ride_leg end,'chauffeur');
        perform public.assert_ride_driver(ride_id);perform public.assert_ride_request_day(ride_id);
        perform public.assert_ride_seats_fit(ride_id);perform public.assert_car_chain(c.id,q.week_start);
        -- REQ §13.88 (owner 2026-09-24): the chain check may have paired this leg with a matching
        -- leg at X (any non-overlapping gap now pairs) — then it is an ordinary driven relay leg,
        -- already `assigned`/RELAY_PAIRED by pair_one_way_legs(); report that instead.
        if exists(select 1 from public.ride_requests rr where rr.request_id=q.id and rr.car_mode='relay') then
          perform set_config('app.system_status_transition','off',true);
          return (select jsonb_build_object('status','assigned','reason','RELAY_PAIRED','needs_driver',false,'ride_id',r.id,'car_id',r.car_id,'starts_at',r.starts_at,'ends_at',r.ends_at)
                  from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q.id limit 1);
        end if;
        update public.requests set status='waitlisted',status_reason='UNMET_NEEDS_DRIVER' where id=q.id;
        perform set_config('app.system_status_transition','off',true);
        return jsonb_build_object('status','waitlisted','reason','UNMET_NEEDS_DRIVER','needs_driver',true,'ride_id',ride_id,'car_id',c.id,'starts_at',start_time,'ends_at',end_time);
      exception when exclusion_violation or sqlstate 'P0410' or sqlstate 'P0411' then null;
      end;
    end loop;
  end if;
  update public.requests set status='waitlisted',status_reason='WAITLISTED_NO_CAR' where id=q.id;
  perform set_config('app.system_status_transition','off',true);
  return jsonb_build_object('status','waitlisted','reason','WAITLISTED_NO_CAR','needs_driver',false);
end $$;

revoke execute on function public.apply_solver_result(uuid, date, jsonb) from public, anon;
grant execute on function public.apply_solver_result(uuid, date, jsonb) to authenticated;
revoke execute on function public.pair_one_way_legs(uuid, date) from public, anon, authenticated;
revoke execute on function public.try_widen_one_way_leg(uuid, uuid, uuid, date, uuid, interval, text) from public, anon, authenticated;
revoke execute on function public.assert_car_chain(uuid, date) from public, anon, authenticated;
