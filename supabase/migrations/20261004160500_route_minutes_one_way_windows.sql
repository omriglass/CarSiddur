-- Every SQL function that derives a request leg's duration from a plain `place_travel()`
-- hop now uses the leg's route minutes instead (REQ §13.93 "Multi-stop rides";
-- ORIGINS_PLAN §6.2/§6.4 item 4): `try_auto_approve` (one-way window), the quick
-- `reserve_live_one_way_slot` chauffeur reservation, `try_widen_one_way_leg`'s chauffeur
-- windows, and `pair_one_way_legs`'s leg windows (each leg uses its own stops, not its
-- opposite leg's). With no stops `request_leg_route_minutes()` reduces to the same single
-- `place_travel()` hop as before -- no behavior change for a stop-free request.

create or replace function public.try_auto_approve(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
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
begin
  select * into v_req from public.requests where id = p_request_id for update;
  if v_req.id is null or v_req.status not in ('submitted', 'waitlisted') then
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
  if v_req.preferred_car_id is not null then
    select c.* into v_car
    from public.cars c
    join public.car_seat_configs csc on csc.car_id = c.id
    where c.id = v_req.preferred_car_id and c.department_id = v_req.department_id
      and c.status = 'active' and c.type = 'shared'
      and csc.adults >= v_req.adults and csc.child_seats >= v_req.child_seats and csc.boosters >= v_req.boosters
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
    perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_req.department_id, v_req.week_start,
      jsonb_build_object('requestId', p_request_id::text), jsonb_build_object('request_id', p_request_id),
      format('waitlisted_request:%s', p_request_id))
    from public.sadranim_of(v_req.department_id, v_req.week_start) as s(profile_id);
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

create or replace function public.reserve_live_one_way_slot(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare q public.requests%rowtype; c record; dwell int; duration_minutes int; travel int;
  start_time timestamptz; end_time timestamptz; buffer_minutes int; ride_id uuid;
  pickup_start timestamptz; pickup_end timestamptz;
  v_start timestamptz; v_end timestamptz; v_loc uuid;
  week_from timestamptz; week_until timestamptz; request_day date;
begin
  select * into q from public.requests where id=p_request_id for update;
  if not found or q.requester_id is distinct from (select auth.uid()) or not public.member_of(q.department_id)
    or q.trip_shape='round_trip' or not exists(select 1 from public.weeks where department_id=q.department_id and week_start=q.week_start and phase='live')
    or exists(select 1 from public.ride_requests where request_id=q.id) then raise exception 'invalid_quick_reservation';end if;
  select coalesce((w.settings_overrides->>'chauffeur_dwell_minutes')::int,s.chauffeur_dwell_minutes,10)
    into dwell from public.department_settings s
    join public.weeks w on w.department_id=s.department_id and w.week_start=q.week_start where s.department_id=q.department_id;
  travel := greatest(coalesce(public.request_leg_route_minutes(
    q.id, case when q.trip_shape='one_way_to' then 'out'::public.ride_leg else 'return'::public.ride_leg end), 30), 0);
  duration_minutes:=greatest(15,ceil((2*travel+greatest(dwell,0))/15.0)::int*15);
  if q.trip_shape='one_way_to' then
    start_time:=q.depart_at;end_time:=q.depart_at+make_interval(mins=>duration_minutes);
    -- Pickup candidate: back at the car's place `t` after collecting the member at D,
    -- rounded up to the 15-minute grid; the window keeps the same total duration.
    pickup_end:=q.depart_at+make_interval(mins=>ceil(travel/15.0)::int*15);
    pickup_start:=pickup_end-make_interval(mins=>duration_minutes);
  else end_time:=q.return_at;start_time:=q.return_at-make_interval(mins=>duration_minutes);end if;
  if start_time<now() then raise exception 'ride_in_past';end if;
  week_from:=q.week_start::timestamp at time zone 'Asia/Jerusalem';
  week_until:=(q.week_start+7)::timestamp at time zone 'Asia/Jerusalem';
  if start_time<week_from or end_time>week_until then raise exception 'ride_outside_week';end if;
  request_day:=(coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date;
  if (start_time at time zone 'Asia/Jerusalem')::date<>request_day then raise exception 'ride_request_day_mismatch';end if;
  buffer_minutes:=coalesce(public.required_turnaround_minutes(q.department_id,q.week_start),30);
  perform set_config('app.audit_reason','reserve_live_one_way_slot',true);
  perform set_config('app.system_status_transition','on',true);
  if q.origin_id is not null then
    for c in select car.id from public.cars car where car.department_id=q.department_id and car.status='active' and car.type='shared'
      and exists(select 1 from public.car_seat_configs seats where seats.car_id=car.id and seats.adults>=q.adults+1 and seats.child_seats>=q.child_seats and seats.boosters>=q.boosters)
      order by (car.id=q.preferred_car_id) desc nulls last,car.id loop
      -- A car being reserved by another transaction is temporarily unavailable; try the next one.
      if not pg_try_advisory_xact_lock(hashtextextended(c.id::text,0)) then continue;end if;
      perform 1 from public.cars where id=c.id and status='active' and type='shared' for share;
      if not found then continue;end if;
      v_loc:=null;
      if public.car_location_at(c.id,start_time) is not distinct from q.origin_id then
        v_start:=start_time;v_end:=end_time;v_loc:=q.origin_id;
      elsif q.trip_shape='one_way_to' and q.destination_id is not null
        and pickup_start>=now() and pickup_start>=week_from
        and (pickup_start at time zone 'Asia/Jerusalem')::date=request_day
        and public.car_location_at(c.id,pickup_start) is not distinct from q.destination_id then
        v_start:=pickup_start;v_end:=pickup_end;v_loc:=q.destination_id;
      end if;
      if v_loc is null
        or exists(select 1 from public.rides r where r.car_id=c.id and r.status<>'cancelled'
          and tstzrange(r.starts_at,r.blocked_until,'[)') && tstzrange(v_start,v_end+make_interval(mins=>buffer_minutes),'[)'))
        or exists(select 1 from public.car_maintenance_blocks b where b.car_id=c.id
          and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(v_start,v_end+make_interval(mins=>buffer_minutes),'[)')) then continue;end if;
      begin
        insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,needs_driver,status,is_pinned,pin_reason,created_by)
          values(q.department_id,q.week_start,c.id,v_start,v_end,v_loc,v_loc,null,true,'confirmed',true,'MISSING_DRIVER',q.requester_id) returning id into ride_id;
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
        return jsonb_build_object('status','waitlisted','reason','UNMET_NEEDS_DRIVER','needs_driver',true,'ride_id',ride_id,'car_id',c.id,'starts_at',v_start,'ends_at',v_end);
      exception when exclusion_violation or sqlstate 'P0410' or sqlstate 'P0411' then null;
      end;
    end loop;
  end if;
  update public.requests set status='waitlisted',status_reason='WAITLISTED_NO_CAR' where id=q.id;
  perform set_config('app.system_status_transition','off',true);
  return jsonb_build_object('status','waitlisted','reason','WAITLISTED_NO_CAR','needs_driver',false);
end $$;

create or replace function public.try_widen_one_way_leg(
  p_ride_id uuid, p_car uuid, p_dept uuid, p_week date, p_home uuid, p_turnaround interval, p_direction text
) returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_ride public.rides%rowtype;
  v_request_id uuid; v_trip_shape public.trip_shape; v_trip_type public.trip_type;
  v_origin uuid; v_dest uuid; v_requester uuid;
  v_travel int; v_dwell int;
  v_start_a timestamptz; v_end_a timestamptz;
  v_start_b timestamptz; v_end_b timestamptz;
  v_start timestamptz; v_end timestamptz; v_loc uuid;
  v_car_id uuid; v_candidate uuid;
  v_was_active boolean;
  v_adults smallint; v_child_seats smallint; v_boosters smallint;
  v_prev_flag text;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride is null or v_ride.status = 'cancelled' then return null; end if;
  if (select count(*) from public.ride_requests where ride_id = p_ride_id) <> 1 then return null; end if;

  select rr.request_id, q.trip_shape, q.trip_type, q.origin_id, q.destination_id, q.requester_id,
         q.adults, q.child_seats, q.boosters
    into v_request_id, v_trip_shape, v_trip_type, v_origin, v_dest, v_requester,
         v_adults, v_child_seats, v_boosters
  from public.ride_requests rr join public.requests q on q.id = rr.request_id
  where rr.ride_id = p_ride_id;
  -- An explicit one_way trip never widens (§1.3a); neither does a round trip or a free-text end.
  if v_trip_type is distinct from 'drop_off' then return null; end if;
  if v_origin is null or v_dest is null then return null; end if;
  if p_direction = 'out' and v_trip_shape <> 'one_way_to' then return null; end if;
  if p_direction = 'fetch' and v_trip_shape <> 'one_way_from' then return null; end if;

  v_was_active := not v_ride.needs_driver;

  select coalesce(
      (select (w.settings_overrides ->> 'chauffeur_dwell_minutes')::int from public.weeks w
       where w.department_id = p_dept and w.week_start = p_week),
      (select s.chauffeur_dwell_minutes from public.department_settings s where s.department_id = p_dept), 10)
    into v_dwell;

  if p_direction = 'out' then
    v_travel := greatest(coalesce(public.request_leg_route_minutes(v_request_id, 'out'), 30), 0);
    -- Candidate A: the car is at the leg's origin -- drop-off wrap, leaves when the leg
    -- already would and comes straight back instead of being left at the destination.
    v_start_a := v_ride.starts_at;
    v_end_a := v_start_a + make_interval(mins => 2 * v_travel + greatest(v_dwell, 0));
    if not (public.is_quarter_hour(v_end_a) or public.is_same_day_end(v_end_a)) then
      v_end_a := to_timestamp(ceil(extract(epoch from v_end_a) / 900) * 900);
    end if;
    -- Candidate B: the car is at the leg's destination -- pickup wrap ("pick me up from X"):
    -- the car fetches the requester at the origin just in time for the stated departure and
    -- returns to the destination.
    v_start_b := v_start_a - make_interval(mins => v_travel + greatest(v_dwell, 0));
    if not public.is_quarter_hour(v_start_b) then
      v_start_b := to_timestamp(floor(extract(epoch from v_start_b) / 900) * 900);
    end if;
    v_end_b := v_start_a + make_interval(mins => v_travel);
    if not public.is_quarter_hour(v_end_b) then
      v_end_b := to_timestamp(ceil(extract(epoch from v_end_b) / 900) * 900);
    end if;

    v_car_id := null;
    for v_candidate in
      select c.id from public.cars c
      where c.department_id = p_dept and c.status = 'active' and c.type = 'shared'
      order by (c.id = p_car) desc, c.id
    loop
      if public.car_location_at(v_candidate, v_start_a) = v_origin
        and public.car_fits(v_candidate, v_adults + 1, v_child_seats, v_boosters)
        and not exists (
          select 1 from public.rides x
          where x.car_id = v_candidate and x.id <> p_ride_id and x.status <> 'cancelled' and not x.planning_conflict
            and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_start_a, v_end_a + p_turnaround, '[)')
        )
      then
        v_car_id := v_candidate; v_start := v_start_a; v_end := v_end_a; v_loc := v_origin;
        exit;
      end if;
    end loop;

    if v_car_id is null then
      for v_candidate in
        select c.id from public.cars c
        where c.department_id = p_dept and c.status = 'active' and c.type = 'shared'
        order by (c.id = p_car) desc, c.id
      loop
        if public.car_location_at(v_candidate, v_start_b) = v_dest
          and public.car_fits(v_candidate, v_adults + 1, v_child_seats, v_boosters)
          and not exists (
            select 1 from public.rides x
            where x.car_id = v_candidate and x.id <> p_ride_id and x.status <> 'cancelled' and not x.planning_conflict
              and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_start_b, v_end_b + p_turnaround, '[)')
          )
        then
          v_car_id := v_candidate; v_start := v_start_b; v_end := v_end_b; v_loc := v_dest;
          exit;
        end if;
      end loop;
    end if;
  else
    -- Legacy return/fetch leg: single formula, now anchored at the request's own origin
    -- (previously always the department home) -- unchanged otherwise.
    v_travel := greatest(coalesce(public.request_leg_route_minutes(v_request_id, 'return'), 30), 0);
    v_end := v_ride.ends_at;
    v_start := v_end - make_interval(mins => 2 * v_travel + greatest(v_dwell, 0));
    if not public.is_quarter_hour(v_start) then
      v_start := to_timestamp(floor(extract(epoch from v_start) / 900) * 900);
    end if;
    v_loc := v_origin;

    v_car_id := p_car;
    if not (public.car_fits(v_car_id, v_adults + 1, v_child_seats, v_boosters)) or exists (
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
        if public.car_fits(v_candidate, v_adults + 1, v_child_seats, v_boosters) and not exists (
          select 1 from public.rides x
          where x.car_id = v_candidate and x.status <> 'cancelled' and not x.planning_conflict
            and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_start, v_end + p_turnaround, '[)')
        ) then
          v_car_id := v_candidate;
          exit;
        end if;
      end loop;
    end if;
  end if;

  if v_start >= v_end then v_end := v_start + interval '15 minutes'; end if;

  if v_car_id is null then
    -- Neither end has an available, seat-fitting car: the request goes back to unmet
    -- (ORIGINS_PLAN §3) instead of staying a dangling chauffeur placeholder.
    delete from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id;
    update public.rides set status = 'cancelled', cancelled_at = now(),
      cancelled_by = coalesce((select auth.uid()), v_ride.created_by), cancel_reason = 'UNMET_NO_CAR_AT_ORIGIN'
    where id = p_ride_id;

    v_prev_flag := coalesce(current_setting('app.system_status_transition', true), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'submitted', status_reason = 'UNMET_NO_CAR_AT_ORIGIN' where id = v_request_id;
    perform set_config('app.system_status_transition', v_prev_flag, true);

    if v_was_active then
      perform public.enqueue_notification(v_requester, 'outcome_changed', p_dept, p_week,
        '{}'::jsonb, jsonb_build_object('request_id', v_request_id),
        format('outcome_changed:%s:%s', v_request_id, now()));
    end if;
    return 'unmet';
  end if;

  update public.rides set
    car_id = v_car_id, origin_id = v_loc, destination_id = v_loc,
    starts_at = v_start, ends_at = v_end, needs_driver = true, driver_id = null,
    -- A former relay leg may carry its short gap at X as an override (20260924120000);
    -- the reshaped chauffeur ride gets the ordinary turnaround again.
    turnaround_override_minutes = null
  where id = p_ride_id;

  update public.ride_requests set role = 'passenger', car_mode = 'chauffeur'
  where ride_id = p_ride_id and request_id = v_request_id;

  if v_was_active then
    perform public.enqueue_notification(v_requester, 'outcome_changed', p_dept, p_week,
      '{}'::jsonb, jsonb_build_object('request_id', v_request_id),
      format('outcome_changed:%s:%s', v_request_id, now()));
  end if;

  return case when v_car_id = p_car then 'here' else 'moved' end;
end $$;

create or replace function public.pair_one_way_legs(p_dept uuid, p_week date) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_turnaround interval; v_travel int;
  out_leg record; ret_leg record;
  v_driver_out uuid; v_driver_ret uuid;
  v_out_start timestamptz; v_out_end timestamptz; v_ret_start timestamptz; v_ret_end timestamptz;
  v_target_car uuid;
  v_gap_override smallint;
  v_out_load record; v_ret_load record;
  v_prev_flag text;
begin
  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(p_dept, p_week), 30));

  for out_leg in
    select r.id as ride_id, r.car_id, r.driver_id, r.needs_driver,
           rr.request_id, q.origin_id, q.destination_id, q.depart_at
    from public.rides r
    join public.ride_requests rr on rr.ride_id = r.id
    join public.requests q on q.id = rr.request_id
    where r.department_id = p_dept and r.week_start = p_week and r.status <> 'cancelled' and not r.planning_conflict
      and not r.auto_relocation and r.overnight_ack_by is null
      and q.trip_shape = 'one_way_to' and q.trip_type = 'drop_off'
      and q.origin_id is not null and q.destination_id is not null
      and (select count(*) from public.ride_requests rr2 where rr2.ride_id = r.id) = 1
    order by r.starts_at
  loop
    v_travel := greatest(coalesce(public.request_leg_route_minutes(out_leg.request_id, 'out'), 30), 0);
    v_out_start := out_leg.depart_at;
    v_out_end := v_out_start + make_interval(mins => v_travel);
    if not public.is_quarter_hour(v_out_end) then
      v_out_end := to_timestamp(ceil(extract(epoch from v_out_end) / 900) * 900);
    end if;

    select x.ride_id, x.car_id, x.request_id, x.ret_start, x.ret_end into ret_leg
    from (
      select r2.id as ride_id, r2.car_id, q2.id as request_id,
             q2.return_at - make_interval(mins => greatest(coalesce(public.request_leg_route_minutes(q2.id, 'return'), 30), 0)) as ret_start,
             q2.return_at as ret_end
      from public.requests q2
      join public.ride_requests rr2 on rr2.request_id = q2.id
      join public.rides r2 on r2.id = rr2.ride_id
      where q2.trip_shape = 'one_way_from' and q2.trip_type = 'drop_off'
        and q2.destination_id = out_leg.destination_id and q2.origin_id = out_leg.origin_id
        and r2.department_id = p_dept and r2.week_start = p_week and r2.status <> 'cancelled' and not r2.planning_conflict
        and not r2.auto_relocation and r2.overnight_ack_by is null
        and (select count(*) from public.ride_requests rr3 where rr3.ride_id = r2.id) = 1
      union all
      select r2.id, r2.car_id, q2.id,
             q2.depart_at,
             q2.depart_at + make_interval(mins => greatest(coalesce(public.request_leg_route_minutes(q2.id, 'out'), 30), 0))
      from public.requests q2
      join public.ride_requests rr2 on rr2.request_id = q2.id
      join public.rides r2 on r2.id = rr2.ride_id
      where q2.trip_shape = 'one_way_to' and q2.trip_type = 'drop_off'
        and q2.origin_id = out_leg.destination_id and q2.destination_id = out_leg.origin_id
        and r2.department_id = p_dept and r2.week_start = p_week and r2.status <> 'cancelled' and not r2.planning_conflict
        and not r2.auto_relocation and r2.overnight_ack_by is null
        and (select count(*) from public.ride_requests rr3 where rr3.ride_id = r2.id) = 1
    ) x
    -- REQ §13.88 (owner 2026-09-24): any non-overlapping gap at X pairs, even one shorter
    -- than the turnaround -- the car just waits there; the out-leg stores the actual gap.
    where x.ret_start >= v_out_end
    order by x.ret_start limit 1;

    if ret_leg.ride_id is null then continue; end if;

    v_driver_out := public.eligible_leg_driver(out_leg.request_id);
    v_driver_ret := public.eligible_leg_driver(ret_leg.request_id);
    if v_driver_out is null or v_driver_ret is null then continue; end if;

    -- Idempotent: already paired correctly (out-leg already relay with the right driver,
    -- on the same car as the return leg) — nothing to do.
    if out_leg.needs_driver = false and out_leg.driver_id = v_driver_out and out_leg.car_id = ret_leg.car_id then
      continue;
    end if;

    if not public.is_quarter_hour(ret_leg.ret_start) then
      v_ret_start := to_timestamp(floor(extract(epoch from ret_leg.ret_start) / 900) * 900);
    else
      v_ret_start := ret_leg.ret_start;
    end if;
    if not public.is_quarter_hour(ret_leg.ret_end) then
      v_ret_end := to_timestamp(ceil(extract(epoch from ret_leg.ret_end) / 900) * 900);
    else
      v_ret_end := ret_leg.ret_end;
    end if;
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

    update public.rides set car_id = v_target_car, origin_id = out_leg.origin_id, destination_id = out_leg.destination_id,
      starts_at = v_out_start, ends_at = v_out_end, needs_driver = false, driver_id = v_driver_out,
      turnaround_override_minutes = v_gap_override
    where id = out_leg.ride_id;
    update public.ride_requests set role = 'driver', car_mode = 'relay'
    where ride_id = out_leg.ride_id and request_id = out_leg.request_id;

    update public.rides set car_id = v_target_car, origin_id = out_leg.destination_id, destination_id = out_leg.origin_id,
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
