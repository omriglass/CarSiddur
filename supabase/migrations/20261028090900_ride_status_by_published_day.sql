-- R13B14 (QA run 13): an accepted origin proposal created a `confirmed` ride on a day not yet published,
-- where every other ride is a `draft`. `try_auto_approve` always wrote `confirmed`, and `place_request_on_car`
-- asked whether the *week* was public (true once any day is published). Both now ask `is_day_public()` for the
-- ride's own day — the same test `publish_siddur` uses when it confirms a day's drafts.

CREATE OR REPLACE FUNCTION "public"."try_auto_approve"("p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_req record;
  v_car record;
  v_turnaround interval;
  v_ride_id uuid;
  v_preferred_ok boolean := false;
  v_is_one_way boolean;
  v_end timestamptz;
  v_travel int;
  v_driver uuid;
  v_pref uuid;
  v_status public.ride_status;
begin
  select * into v_req from public.requests where id = p_request_id for update;
  if v_req.id is null or v_req.status not in ('submitted', 'waitlisted') then
    return null;
  end if;

  -- REQ §13.94: a drop_off (with or without a pickup) is never auto-placed; it is two
  -- separate trips for the Sadran/solver, not one block that holds the car.
  if v_req.trip_type = 'drop_off' then
    return null;
  end if;

  v_is_one_way := v_req.trip_shape = 'one_way_to' and v_req.trip_type = 'one_way';
  if v_req.trip_shape <> 'round_trip' and not v_is_one_way then
    return null;
  end if;
  -- A free-text origin is never auto-placed (REQ §13.93: "the Sadran handles it").
  if v_req.origin_id is null then
    return null;
  end if;

  perform set_config('app.system_status_transition', 'on', true);

  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(v_req.department_id, v_req.week_start), 30));

  if v_is_one_way then
    -- A free-text destination can never relay (REQ §13.58); no window to compute either.
    if v_req.destination_id is null then
      perform set_config('app.system_status_transition', 'off', true);
      return null;
    end if;
    v_driver := public.eligible_leg_driver(p_request_id);
    if v_driver is null then
      -- No eligible driver on board: not this function's job (submit_request's
      -- non_driver_needs_drop_off guard should have prevented this at submission time).
      perform set_config('app.system_status_transition', 'off', true);
      return null;
    end if;
    v_travel := greatest(coalesce(public.request_leg_route_minutes(p_request_id, 'out'), 30), 0);
    v_end := v_req.depart_at + make_interval(mins => v_travel);
    if not public.is_quarter_hour(v_end) then
      v_end := to_timestamp(ceil(extract(epoch from v_end) / 900) * 900);
    end if;
  else
    v_end := v_req.return_at;
  end if;

  -- Preferred car first: same eligibility rules as the fallback query below (shared,
  -- active, seats fit, at the request's origin at departure, no overlap incl. the
  -- turnaround buffer, and -- for a one-way leg -- no later ride on that car starting
  -- anywhere but the destination, and none -> the destination must be the car's base, REQ §13.136 c), scoped to that single car.
  v_pref := coalesce(v_req.preferred_car_id, nullif(current_setting('app.edit_prefer_car', true), '')::uuid);
  if v_pref is not null then
    select c.* into v_car
    from public.cars c
    join public.car_seat_configs csc on csc.car_id = c.id
    where c.id = v_pref and c.department_id = v_req.department_id
      and c.status = 'active' and c.type = 'shared'
      and csc.adults >= v_req.adults and csc.child_seats >= v_req.child_seats and csc.boosters >= v_req.boosters
      and (not (v_req.has_luggage and v_req.luggage_waived_at is null) or 'large_trunk' = any(c.features))
      and public.car_location_at(c.id, v_req.depart_at) = v_req.origin_id
      and not exists (
        select 1 from public.rides r
        where r.car_id = c.id and r.status <> 'cancelled'
          and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_req.depart_at, v_end + v_turnaround, '[)')
      )
      -- REQ §13.114: never inside a scheduled maintenance period (incl. the turnaround buffer before it).
      and not exists (
        select 1 from public.car_maintenance_blocks b
        where b.car_id = c.id
          and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_req.depart_at, v_end + v_turnaround, '[)')
      )
      and (not v_is_one_way or public.car_week_end_ok(c.id, v_end, v_req.destination_id))   -- REQ §13.136 c: no next ride -> the base
    order by c.id limit 1;
    v_preferred_ok := v_car.id is not null;
  end if;

  if not v_preferred_ok then
    select c.* into v_car
    from public.cars c
    join public.car_seat_configs csc on csc.car_id = c.id
    where c.department_id = v_req.department_id and c.status = 'active' and c.type = 'shared'
      and csc.adults >= v_req.adults and csc.child_seats >= v_req.child_seats and csc.boosters >= v_req.boosters
      and (not (v_req.has_luggage and v_req.luggage_waived_at is null) or 'large_trunk' = any(c.features))
      and public.car_location_at(c.id, v_req.depart_at) = v_req.origin_id
      and not exists (
        select 1 from public.rides r
        where r.car_id = c.id and r.status <> 'cancelled'
          and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_req.depart_at, v_end + v_turnaround, '[)')
      )
      -- REQ §13.114: never inside a scheduled maintenance period (incl. the turnaround buffer before it).
      and not exists (
        select 1 from public.car_maintenance_blocks b
        where b.car_id = c.id
          and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_req.depart_at, v_end + v_turnaround, '[)')
      )
      and (not v_is_one_way or public.car_week_end_ok(c.id, v_end, v_req.destination_id))   -- REQ §13.136 c: no next ride -> the base
    order by c.id limit 1;
  end if;

  if v_car.id is null then
    perform set_config('app.audit_reason', 'try_auto_approve:no_car', true);
    update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_NO_CAR' where id = p_request_id;
    -- REQ §13.100 (QB24): the publish sweep (form_waitlist_groups) tells the Sadran once, through the
    -- contested-group notice, not with a "new request" notice per leftover request.
    if coalesce(current_setting('app.waitlist_sweep', true), 'off') <> 'on'
       and coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on' then
      perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_req.department_id, v_req.week_start,
        jsonb_build_object('requestId', p_request_id::text), jsonb_build_object('request_id', p_request_id),
        format('waitlisted_request:%s', p_request_id))
      from public.sadranim_of(v_req.department_id, v_req.week_start) as s(profile_id);
    end if;
    perform set_config('app.system_status_transition', 'off', true);
    -- 20260910091900 (contested waiting-list groups, REQ §7.3): join_waitlist_group() is a
    -- round-trip-only no-op for a one-way leg, so this stays safe to call unconditionally.
    if public.join_waitlist_group(p_request_id) is not null then
      return jsonb_build_object('status', 'waitlisted', 'reason', 'WAITLISTED_CONTESTED');
    end if;
    return jsonb_build_object('status', 'waitlisted', 'reason', 'WAITLISTED_NO_CAR');
  end if;

  perform set_config('app.audit_reason', 'try_auto_approve:assigned', true);
  -- R13B14: a ride on a day that is not published yet is a draft, like every other ride there.
  v_status := case when public.is_day_public(v_req.department_id, v_req.week_start,
                      (v_req.depart_at at time zone 'Asia/Jerusalem')::date)
              then 'confirmed'::public.ride_status else 'draft'::public.ride_status end;
  if v_is_one_way then
    insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
      driver_id, status, is_pinned, pin_reason, created_by)
    values (v_req.department_id, v_req.week_start, v_car.id, v_req.depart_at, v_end, v_req.origin_id, v_req.destination_id,
      v_driver, v_status, true, 'AUTO_APPROVED', v_req.requester_id)
    returning id into v_ride_id;

    insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
    values (v_ride_id, p_request_id, 'driver', 'out', 'relay');

    update public.requests set status = 'assigned', status_reason = 'AUTO_APPROVED_RELAY' where id = p_request_id;
  else
    insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
      driver_id, status, is_pinned, pin_reason, created_by)
    values (v_req.department_id, v_req.week_start, v_car.id, v_req.depart_at, v_req.return_at, v_req.origin_id, v_req.origin_id,
      v_req.requester_id, v_status, true, 'AUTO_APPROVED', v_req.requester_id)
    returning id into v_ride_id;

    insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
    values (v_ride_id, p_request_id, 'driver', 'both', 'keep');

    update public.requests set status = 'assigned', status_reason = 'AUTO_APPROVED_FREE_CAR' where id = p_request_id;
  end if;

  perform public.assert_car_chain(v_car.id, v_req.week_start);
  perform set_config('app.system_status_transition', 'off', true);

  perform public.enqueue_notification(v_req.requester_id, 'auto_approved', v_req.department_id, v_req.week_start,
    jsonb_build_object('requestId', p_request_id::text), jsonb_build_object('request_id', p_request_id, 'ride_id', v_ride_id),
    format('auto_approved:%s', p_request_id));
  perform public.enqueue_notification(s.profile_id, 'auto_approved', v_req.department_id, v_req.week_start,
    jsonb_build_object('requestId', p_request_id::text), jsonb_build_object('request_id', p_request_id, 'ride_id', v_ride_id),
    format('auto_approved:%s:%s', p_request_id, s.profile_id))
  from public.sadranim_of(v_req.department_id, v_req.week_start) as s(profile_id);

  return jsonb_build_object('status', 'assigned', 'ride_id', v_ride_id, 'car_id', v_car.id);
end;
$$;




CREATE OR REPLACE FUNCTION "public"."place_request_on_car"("p_request_id" "uuid", "p_car_id" "uuid", "p_manual" boolean, "p_actor" "uuid", "p_named_driver" "uuid", "p_dep" timestamp with time zone, "p_ret" timestamp with time zone, "p_reason" "text" DEFAULT 'PROPOSAL_APPLIED'::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  q public.requests%rowtype; v_home uuid;
  v_car uuid; v_dep timestamptz; v_ret timestamptz; v_manual boolean; v_public boolean;
  v_named uuid; v_driver uuid; v_old record; v_old_cars uuid[] := '{}'; v_old_car uuid;
  v_ride uuid; v_first uuid; v_rides uuid[] := '{}'; v_end timestamptz;
  v_travel int; v_dur int; v_dwell int; v_gap smallint; v_buffer int;
  v_week_from timestamptz; v_week_until timestamptz; v_day date;
  v_leg public.ride_leg; v_at timestamptz; v_legs int := 0; v_wanted int := 0;
  v_s timestamptz; v_e timestamptz; v_loc uuid; v_ok boolean; k int; c int; v_rid uuid;
  v_relay boolean; v_pickup_driver uuid; v_needs_driver boolean := false;
begin
  select * into q from public.requests where id = p_request_id for update;
  if q.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  v_car := p_car_id;
  if not exists(select 1 from public.cars where id = v_car and department_id = q.department_id and status = 'active') then
    raise exception 'shift_car_invalid' using errcode = 'P0001';
  end if;
  -- REQ §13.99: only the owner puts requests on a private car (the owner's own request on it is fine).
  -- REQ §13.127 (c): so is a request the owner filed for someone else.
  perform public.assert_private_car_request(v_car, p_actor, p_request_id);
  v_manual := coalesce(p_manual, false);
  v_dep := case when q.trip_shape = 'one_way_from' then null else coalesce(p_dep, q.depart_at) end;
  v_ret := case when q.trip_type = 'one_way' or q.trip_shape = 'one_way_to' then null
                else coalesce(p_ret, q.return_at) end;
  if v_dep is null and v_ret is null then raise exception 'shift_car_invalid' using errcode = 'P0001'; end if;
  -- R13B14: confirmed only on a published day; the rest of the week's rides are drafts.
  v_public := public.is_day_public(q.department_id, q.week_start, (coalesce(v_dep, v_ret) at time zone 'Asia/Jerusalem')::date);
  if v_dep is distinct from q.depart_at or v_ret is distinct from q.return_at then
    update public.requests set depart_at = v_dep, return_at = v_ret where id = q.id;
  end if;
  select * into q from public.requests where id = q.id;
  v_day := (coalesce(v_dep, v_ret) at time zone 'Asia/Jerusalem')::date;
  v_week_from := q.week_start::timestamp at time zone 'Asia/Jerusalem';
  v_week_until := (q.week_start + 7)::timestamp at time zone 'Asia/Jerusalem';
  v_buffer := coalesce(public.required_turnaround_minutes(q.department_id, q.week_start), 30);

  -- Replace the request's previous placement.
  for v_old in select rd.* from public.rides rd join public.ride_requests rr on rr.ride_id = rd.id
    where rr.request_id = q.id and rd.status <> 'cancelled' order by rd.id for update of rd loop
    continue when coalesce(current_setting('app.place_only_missing', true), 'off') = 'on'   -- R2B3: keep legs already served
      or coalesce(current_setting('app.place_only_leg', true), '') in ('out', 'return');   -- R4B4: the other leg stays
    if exists(select 1 from public.ride_requests where ride_id = v_old.id and request_id <> q.id) then
      if not v_manual then raise exception 'shared_ride_requires_sadran'; end if;
    else
      update public.rides set status = 'cancelled', cancelled_at = now(),
        cancelled_by = coalesce(p_actor, q.requester_id), cancel_reason = 'REPLACED_BY_PROPOSAL' where id = v_old.id;
    end if;
    delete from public.ride_requests where ride_id = v_old.id and request_id = q.id;
    v_old_cars := v_old_cars || v_old.car_id;
  end loop;

  if q.trip_type = 'round_trip' then
    -- REQ §13.95 H3: a round trip is one ride, the requester (or a driving companion) drives, car kept.
    v_driver := public.eligible_leg_driver(q.id);
    if v_driver is null then raise exception 'non_driver_needs_drop_off' using errcode = 'P0001'; end if;
    if v_dep is null or v_ret is null then raise exception 'shift_car_invalid' using errcode = 'P0001'; end if;
    select home_destination_id into v_home from public.departments where id = q.department_id;
    v_loc := coalesce(q.origin_id, v_home);
    -- R6B4 (REQ §13.93): the same rule as every other placement -- a shared car is used only where it stands, and
    -- the round trip must leave it where the car's next ride expects it (else the caller keeps the request unmet).
    if exists(select 1 from public.cars where id = v_car and type = 'shared') then
      if public.car_location_at(v_car, v_dep) is distinct from v_loc then
        raise exception 'car_not_at_leg_origin' using errcode = 'P0001';
      end if;
      if coalesce(public.car_next_ride_origin(v_car, v_ret), v_loc) <> v_loc then
        raise exception 'car_next_ride_elsewhere' using errcode = 'P0001';
      end if;
    end if;
    v_gap := null;
    if v_manual then v_gap := public.prepare_manual_ride_window(v_car, q.week_start, v_dep, v_ret, null); end if;
    insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id,
      status, is_pinned, pin_reason, created_by, turnaround_override_minutes)
    values(q.department_id, q.week_start, v_car, v_dep, v_ret, v_loc, v_loc, v_driver,
      case when v_public then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
      true, p_reason, p_actor, v_gap) returning id into v_ride;
    insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values(v_ride, q.id, 'driver', 'both', 'keep');
    v_first := v_ride; v_rides := array[v_ride];
    update public.requests set status = 'assigned', status_reason = p_reason where id = q.id;
  elsif q.trip_type = 'one_way' then
    if q.origin_id is null or q.destination_id is null then raise exception 'shift_car_invalid' using errcode = 'P0001'; end if;
    v_driver := public.eligible_leg_driver(q.id);
    if v_driver is null then raise exception 'no_eligible_driver' using errcode = 'P0001'; end if;
    v_travel := greatest(coalesce(public.request_leg_route_minutes(q.id, 'out'), 30), 0);
    v_end := greatest(public._round_up_ride_end(v_dep, v_dep + make_interval(mins => v_travel)), v_dep + interval '15 minutes');
    if public.car_location_at(v_car, v_dep) is distinct from q.origin_id then
      raise exception 'car_not_at_leg_origin' using errcode = 'P0001';
    end if;
    if coalesce(public.car_next_ride_origin(v_car, v_end), q.destination_id) <> q.destination_id then
      raise exception 'car_next_ride_elsewhere' using errcode = 'P0001';
    end if;
    -- REQ §13.136 c: an automatic placement never leaves a shared car away from its base with nothing bringing it
    -- back. A Sadran's manual placement and an accepted proposal (a human decision) stay allowed.
    if not v_manual and p_reason <> 'PROPOSAL_APPLIED'
       and exists(select 1 from public.cars where id = v_car and type = 'shared')
       and not public.car_week_end_ok(v_car, v_end, q.destination_id) then
      raise exception 'car_week_end_away' using errcode = 'P0001';
    end if;
    v_gap := null;
    if v_manual then v_gap := public.prepare_manual_ride_window(v_car, q.week_start, v_dep, v_end, null); end if;
    insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id,
      status, is_pinned, pin_reason, created_by, turnaround_override_minutes)
    values(q.department_id, q.week_start, v_car, v_dep, v_end, q.origin_id, q.destination_id, v_driver,
      case when v_public then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
      true, p_reason, p_actor, v_gap) returning id into v_ride;
    insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values(v_ride, q.id, 'driver', 'out', 'relay');
    v_first := v_ride; v_rides := array[v_ride];
    update public.requests set status = 'assigned', status_reason = p_reason where id = q.id;
  else
    -- drop_off: one chauffeur ride per leg.
    v_named := p_named_driver;
    if v_named is not null and not exists(select 1 from public.department_members
      where department_id = q.department_id and profile_id = v_named and removed_at is null) then
      raise exception 'shift_car_invalid' using errcode = 'P0001';
    end if;
    select coalesce((w.settings_overrides ->> 'chauffeur_dwell_minutes')::int, s.chauffeur_dwell_minutes, 10) into v_dwell
    from public.department_settings s join public.weeks w on w.department_id = s.department_id and w.week_start = q.week_start
    where s.department_id = q.department_id;
    v_dwell := coalesce(v_dwell, 10);
    for k in 1..2 loop
      if k = 1 then v_leg := 'out'; v_at := v_dep; else v_leg := 'return'; v_at := v_ret; end if;
      continue when v_at is null;
      continue when coalesce(current_setting('app.place_only_leg', true), '') in ('out', 'return')   -- R4B4: a single-leg shift places only that leg
        and v_leg::text <> current_setting('app.place_only_leg', true);
      continue when coalesce(current_setting('app.place_only_missing', true), 'off') = 'on' and v_leg::text = any(public.request_covered_legs(q.id));
      v_wanted := v_wanted + 1;
      v_travel := greatest(coalesce(public.request_leg_route_minutes(q.id, v_leg), 30), 0);
      v_dur := public.chauffeur_ride_minutes(q.id, v_leg);   -- R8B13: the one chauffeur-duration rule (same as the solver)
      v_ok := false; v_relay := false; v_pickup_driver := null;
      -- REQ §13.105 b (QA run 5 R5Q2): a pickup from X on a car already standing at X, driven home by the requester
      -- (or a driving companion) -- candidate 0, before the chauffeur wraps. Not when the Sadran named a volunteer.
      if v_leg = 'return' and v_named is null and q.origin_id is not null and q.destination_id is not null
         and q.origin_id <> q.destination_id then
        v_pickup_driver := public.eligible_leg_driver(q.id);
      end if;
      for c in 0..2 loop
        continue when c = 0 and v_pickup_driver is null;
        continue when c = 2 and v_leg <> 'out';
        if c = 0 then
          v_loc := q.destination_id; v_relay := true;
          v_e := v_at; v_s := v_e - make_interval(mins => greatest(15, ceil(v_travel / 15.0)::int * 15));
        elsif c = 1 then
          v_relay := false;
          v_loc := q.origin_id;
          if v_leg = 'out' then v_s := v_at; v_e := v_at + make_interval(mins => v_dur);
          else v_e := v_at; v_s := v_at - make_interval(mins => v_dur); end if;
        else
          v_relay := false;
          v_loc := q.destination_id;
          v_e := v_at + make_interval(mins => ceil(v_travel / 15.0)::int * 15); v_s := v_e - make_interval(mins => v_dur);
        end if;
        continue when v_loc is null or v_s < v_week_from or v_e > v_week_until
          or (v_s at time zone 'Asia/Jerusalem')::date <> v_day
          or ((v_e - interval '1 minute') at time zone 'Asia/Jerusalem')::date <> v_day
          or public.car_location_at(v_car, v_s) is distinct from v_loc
          or exists(select 1 from public.rides r where r.car_id = v_car and r.status <> 'cancelled'
            and tstzrange(r.starts_at, case when v_manual then r.ends_at else r.blocked_until end, '[)')
              && tstzrange(v_s, case when v_manual then v_e else v_e + make_interval(mins => v_buffer) end, '[)'))
          or exists(select 1 from public.car_maintenance_blocks b where b.car_id = v_car
            and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_s, v_e, '[)'))
          or (c = 0 and (not public.car_fits(v_car, q.adults, q.child_seats, q.boosters)
            or coalesce(public.car_next_ride_origin(v_car, v_e), q.origin_id) <> q.origin_id
            -- REQ §13.136 c: the pickup relay ends the car at the origin; automatic, so never away from base
            or (not v_manual and p_reason <> 'PROPOSAL_APPLIED'
                and not public.car_week_end_ok(v_car, v_e, q.origin_id))));
        v_ok := true; exit;
      end loop;
      continue when not v_ok;
      v_gap := null;
      if v_manual then v_gap := public.prepare_manual_ride_window(v_car, q.week_start, v_s, v_e, null); end if;
      if v_relay then
        insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id,
          status, is_pinned, pin_reason, created_by, turnaround_override_minutes)
        values(q.department_id, q.week_start, v_car, v_s, v_e, q.destination_id, q.origin_id, v_pickup_driver,
          case when v_public then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
          true, p_reason, p_actor, v_gap)
        returning id into v_ride;
        insert into public.ride_requests(ride_id, request_id, role, leg, car_mode)
        values(v_ride, q.id, case when v_pickup_driver = q.requester_id then 'driver' else 'passenger' end::public.ride_role, 'return', 'relay');
        v_legs := v_legs + 1; v_rides := v_rides || v_ride;
        v_first := coalesce(v_first, v_ride);
        continue;
      end if;
      v_needs_driver := v_needs_driver or v_named is null;
      insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, needs_driver,
        status, is_pinned, pin_reason, created_by, turnaround_override_minutes)
      values(q.department_id, q.week_start, v_car, v_s, v_e, v_loc, v_loc, v_named, v_named is null,
        case when v_public then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
        true, case when v_named is null then 'MISSING_DRIVER' else p_reason end, p_actor, v_gap)
      returning id into v_ride;
      insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values(v_ride, q.id, 'passenger', v_leg, 'chauffeur');
      v_legs := v_legs + 1; v_rides := v_rides || v_ride;
      v_first := coalesce(v_first, v_ride);
    end loop;
    if v_legs = 0 then raise exception 'car_not_at_leg_place' using errcode = 'P0001'; end if;
    if v_named is null and v_needs_driver then
      update public.requests set status = 'waitlisted', status_reason = 'UNMET_NEEDS_DRIVER' where id = q.id;
    else
      update public.requests set status = 'assigned',
        status_reason = case when v_legs < v_wanted then p_reason || '_PARTIAL' else p_reason end where id = q.id;
    end if;
  end if;

  foreach v_rid in array v_rides loop
    perform public.assert_ride_request_day(v_rid);
    perform public.assert_ride_seats_fit(v_rid);
    perform public.assert_ride_driver(v_rid);
  end loop;
  perform public.assert_car_chain(v_car, q.week_start);
  foreach v_old_car in array v_old_cars loop
    if v_old_car <> v_car then perform public.assert_car_chain(v_old_car, q.week_start); end if;
  end loop;
  return v_first;
end;
$$;


