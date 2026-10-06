-- REQ §13.103 R3B14: a published-day edit's re-placement prefers the car the request was booked on (app.edit_prefer_car, set by submit_request) when the member named none.
create or replace function public."try_auto_approve"("p_request_id" "uuid") RETURNS "jsonb"
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

  select make_interval(mins => s.turnaround_minutes) into v_turnaround
  from public.department_settings s where s.department_id = v_req.department_id;

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
  -- anywhere but the destination), scoped to that single car.
  v_pref := coalesce(v_req.preferred_car_id, nullif(current_setting('app.edit_prefer_car', true), '')::uuid);
  if v_pref is not null then
    select c.* into v_car
    from public.cars c
    join public.car_seat_configs csc on csc.car_id = c.id
    where c.id = v_pref and c.department_id = v_req.department_id
      and c.status = 'active' and c.type = 'shared'
      and csc.adults >= v_req.adults and csc.child_seats >= v_req.child_seats and csc.boosters >= v_req.boosters
      and (not v_req.has_luggage or 'large_trunk' = any(c.features))
      and public.car_location_at(c.id, v_req.depart_at) = v_req.origin_id
      and not exists (
        select 1 from public.rides r
        where r.car_id = c.id and r.status <> 'cancelled'
          and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_req.depart_at, v_end + v_turnaround, '[)')
      )
      and (not v_is_one_way or coalesce(public.car_next_ride_origin(c.id, v_end), v_req.destination_id) = v_req.destination_id)
    order by c.id limit 1;
    v_preferred_ok := v_car.id is not null;
  end if;

  if not v_preferred_ok then
    select c.* into v_car
    from public.cars c
    join public.car_seat_configs csc on csc.car_id = c.id
    where c.department_id = v_req.department_id and c.status = 'active' and c.type = 'shared'
      and csc.adults >= v_req.adults and csc.child_seats >= v_req.child_seats and csc.boosters >= v_req.boosters
      and (not v_req.has_luggage or 'large_trunk' = any(c.features))
      and public.car_location_at(c.id, v_req.depart_at) = v_req.origin_id
      and not exists (
        select 1 from public.rides r
        where r.car_id = c.id and r.status <> 'cancelled'
          and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_req.depart_at, v_end + v_turnaround, '[)')
      )
      and (not v_is_one_way or coalesce(public.car_next_ride_origin(c.id, v_end), v_req.destination_id) = v_req.destination_id)
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
  if v_is_one_way then
    insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
      driver_id, status, is_pinned, pin_reason, created_by)
    values (v_req.department_id, v_req.week_start, v_car.id, v_req.depart_at, v_end, v_req.origin_id, v_req.destination_id,
      v_driver, 'confirmed', true, 'AUTO_APPROVED', v_req.requester_id)
    returning id into v_ride_id;

    insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
    values (v_ride_id, p_request_id, 'driver', 'out', 'relay');

    update public.requests set status = 'assigned', status_reason = 'AUTO_APPROVED_RELAY' where id = p_request_id;
  else
    insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
      driver_id, status, is_pinned, pin_reason, created_by)
    values (v_req.department_id, v_req.week_start, v_car.id, v_req.depart_at, v_req.return_at, v_req.origin_id, v_req.origin_id,
      v_req.requester_id, 'confirmed', true, 'AUTO_APPROVED', v_req.requester_id)
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

