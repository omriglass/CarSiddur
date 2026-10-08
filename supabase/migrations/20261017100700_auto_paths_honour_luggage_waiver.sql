-- REQ §13.111 (a): the automatic paths (auto-approve, waiting-list settling, freed-car offers, "is a car free at
-- the origin") never waive anything, but a request whose large-trunk requirement was already waived by hand no
-- longer needs one: they treat it as a request without large luggage. A non-waived large-luggage request still
-- needs a large_trunk car exactly as before.

CREATE OR REPLACE FUNCTION public.freed_slot_candidates(_offer uuid)
 RETURNS TABLE(request_id uuid, requester_id uuid, fits boolean, slack interval)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select q.id, q.requester_id,
         public.car_fits(o.car_id, q.adults, q.child_seats, q.boosters) as fits,
         (o.ends_at - o.starts_at) - (q.return_at - q.depart_at) as slack
  from freed_slot_offers o
  join rides cr on cr.id = o.cancelled_ride_id
  join requests q
    on q.department_id = o.department_id and q.week_start = o.week_start
   and q.status in ('waitlisted','denied','external')
   and not q.freed_slot_opt_out
   and q.trip_shape = 'round_trip'                     -- one-way requests are never auto-placed (REQ §13.64)
   and q.series_id is null                             -- REQ §13.77: a multi-day series never fits a one-day freed slot
   -- R2B3: a request that already holds one leg is only a candidate for a הקפצה (the missing leg is placed alone)
   and (q.trip_type = 'drop_off' or cardinality(public.request_covered_legs(q.id)) = 0)
   -- REQ §13.102 (b): the request's own times lie inside the car's free gap, and it starts where the car is
   and q.depart_at >= o.starts_at and q.return_at <= o.ends_at
   and (q.origin_id = cr.origin_id or (q.origin_id is null and q.origin_text is null))
   and not exists (select 1 from rides r2 where r2.car_id = o.car_id and r2.status <> 'cancelled'
        and r2.id <> o.cancelled_ride_id and not r2.planning_conflict
        and tstzrange(r2.starts_at, r2.blocked_until, '[)') && tstzrange(q.depart_at, q.return_at, '[)'))
  where o.id = _offer and o.status = 'open'
    and cr.origin_id = cr.destination_id
    and public.car_fits(o.car_id, q.adults, q.child_seats, q.boosters)
    and public.car_takes_luggage(o.car_id, case when q.has_luggage and q.luggage_waived_at is null then 1 else 0 end)
  order by slack asc, q.submitted_at asc;
$function$
;

CREATE OR REPLACE FUNCTION public.request_has_free_car_at_origin(p_request_id uuid, p_strict boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare q public.requests%rowtype; v_ta interval;
begin
  select * into q from public.requests where id = p_request_id;
  if q.id is null or q.origin_id is null or q.depart_at is null then return false; end if;
  v_ta := make_interval(mins => coalesce(public.required_turnaround_minutes(q.department_id, q.week_start), 30));
  return exists (
    select 1 from public.cars c
    where c.department_id = q.department_id and c.status = 'active' and c.type = 'shared'
      and public.car_fits(c.id, q.adults, q.child_seats, q.boosters)
      and public.car_takes_luggage(c.id, case when q.has_luggage and q.luggage_waived_at is null then 1 else 0 end)
      and public.car_location_at(c.id, q.depart_at) = q.origin_id
      and (not p_strict or (
        not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled' and not r.planning_conflict
          and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(q.depart_at, coalesce(q.return_at, q.depart_at + interval '1 hour') + v_ta, '[)'))
        and not exists (select 1 from public.car_maintenance_blocks b where b.car_id = c.id
          and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(q.depart_at, coalesce(q.return_at, q.depart_at + interval '1 hour'), '[)')))));
end $function$
;

CREATE OR REPLACE FUNCTION public.try_auto_approve(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  -- anywhere but the destination), scoped to that single car.
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
      and (not (v_req.has_luggage and v_req.luggage_waived_at is null) or 'large_trunk' = any(c.features))
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
$function$
;

CREATE OR REPLACE FUNCTION public.settle_waitlist_group(p_group_id uuid, p_request_ids uuid[], p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  g record;
  v_driver_request uuid;
  v_driver_profile uuid;
  v_driver_name text;
  v_preferred uuid;
  v_home uuid;
  v_turnaround interval;
  v_car public.cars%rowtype;
  v_starts timestamptz;
  v_ends timestamptz;
  v_adults int; v_child_seats int; v_boosters int;
  v_ride uuid;
  v_id uuid;
  v_chosen_names text;
  v_day text; v_depart text; v_return text;
  m record; v_sadran uuid; v_variant text; v_lug int;
begin
  select * into g from public.waitlist_groups where id = p_group_id for update;
  if g.id is null then raise exception 'waitlist_group_not_found' using errcode = 'P0001'; end if;
  if g.status <> 'open' then raise exception 'waitlist_group_closed' using errcode = 'P0001'; end if;

  if coalesce(cardinality(p_request_ids), 0) = 0
     or cardinality(p_request_ids) <> (select count(distinct x) from unnest(p_request_ids) x)
     or exists (select 1 from unnest(p_request_ids) rid where not exists (
          select 1 from public.waitlist_group_members wm
          where wm.group_id = g.id and wm.request_id = rid and wm.chosen is null))
  then
    raise exception 'waitlist_selection_invalid' using errcode = 'P0001';
  end if;

  v_driver_request := p_request_ids[1];
  select q.requester_id, q.preferred_car_id into v_driver_profile, v_preferred
  from public.requests q where q.id = v_driver_request;

  select coalesce((select q.origin_id from public.requests q where q.id = v_driver_request), d.home_destination_id) into v_home
  from public.departments d where d.id = g.department_id;
  if v_home is null then raise exception 'no_home_location' using errcode = 'P0412'; end if;

  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(g.department_id, g.week_start), 30));

  select min(q.depart_at), max(q.return_at),
         sum(q.adults)::int, sum(q.child_seats)::int, sum(q.boosters)::int
    into v_starts, v_ends, v_adults, v_child_seats, v_boosters
  from public.requests q where q.id = any(p_request_ids);

  select count(*) filter (where q.has_luggage and q.luggage_waived_at is null) into v_lug from public.requests q where q.id = any(p_request_ids);

  -- REQ §13.101 (i): a car freed for this group (held offer) is the first choice.
  select c.* into v_car from public.cars c join public.freed_slot_offers fo on fo.car_id = c.id
  where fo.group_id = g.id and fo.status = 'open'
    and c.status = 'active' and c.type = 'shared'
    and public.car_fits(c.id, v_adults, v_child_seats, v_boosters)
    and public.car_takes_luggage(c.id, v_lug)
    and public.car_location_at(c.id, v_starts) = v_home
    and not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled'
      and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_starts, v_ends + v_turnaround, '[)'))
  order by c.id limit 1;

  if v_car.id is null and v_preferred is not null then
    select c.* into v_car from public.cars c
    where c.id = v_preferred and c.department_id = g.department_id
      and c.status = 'active' and c.type = 'shared'
      and public.car_fits(c.id, v_adults, v_child_seats, v_boosters)
      and public.car_takes_luggage(c.id, v_lug)
      and public.car_location_at(c.id, v_starts) = v_home
      and not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled'
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_starts, v_ends + v_turnaround, '[)'));
  end if;
  if v_car.id is null then
    select c.* into v_car from public.cars c
    where c.department_id = g.department_id and c.status = 'active' and c.type = 'shared'
      and public.car_fits(c.id, v_adults, v_child_seats, v_boosters)
      and public.car_takes_luggage(c.id, v_lug)
      and public.car_location_at(c.id, v_starts) = v_home
      and not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled'
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_starts, v_ends + v_turnaround, '[)'))
    order by c.id limit 1;
  end if;
  if v_car.id is null then
    raise exception 'no_car_free' using errcode = 'WLG01';
  end if;

  perform set_config('app.audit_reason', 'resolve_waitlist_group', true);

  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, is_pinned, pin_reason, created_by)
  values (g.department_id, g.week_start, v_car.id, v_starts, v_ends, v_home, v_home,
    v_driver_profile, 'confirmed', true, 'WAITLIST_RESOLVED', p_actor)
  returning id into v_ride;

  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
  values (v_ride, v_driver_request, 'driver', 'both', 'keep');

  foreach v_id in array p_request_ids loop
    if v_id <> v_driver_request then
      insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
      values (v_ride, v_id, 'passenger', 'both', 'passenger');
    end if;
  end loop;

  perform public.assert_car_chain(v_car.id, g.week_start);

  update public.waitlist_group_members set chosen = (request_id = any(p_request_ids))
  where group_id = g.id and chosen is null;

  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'assigned', status_reason = 'WAITLIST_RESOLVED_DRIVER'
  where id = v_driver_request;
  update public.requests set status = 'merged', status_reason = 'WAITLIST_RESOLVED_PASSENGER'
  where id = any(p_request_ids) and id <> v_driver_request;
  -- Was bare before this migration: an unchosen participant's request is a DIFFERENT row
  -- than the actor's own when the actor is a mere participant, not a Sadran.
  update public.requests set status_reason = 'WAITLISTED_NOT_CHOSEN'
  where id in (select wm.request_id from public.waitlist_group_members wm
               where wm.group_id = g.id and wm.chosen = false)
    and status = 'waitlisted';
  perform set_config('app.system_status_transition', 'off', true);

  update public.waitlist_groups
  set status = 'resolved', ride_id = v_ride, resolved_by = p_actor, resolved_at = now()
  where id = g.id;

  select full_name into v_driver_name from public.profiles where id = v_driver_profile;
  select string_agg(coalesce(p.full_name, ''), ', ' order by m2.created_at, m2.id) into v_chosen_names
  from public.waitlist_group_members m2 join public.profiles p on p.id = m2.profile_id
  where m2.group_id = g.id and m2.chosen;
  v_day := public.day_date_label(g.day);
  v_depart := to_char(v_starts at time zone 'Asia/Jerusalem', 'HH24:MI');
  v_return := to_char(v_ends at time zone 'Asia/Jerusalem', 'HH24:MI');

  for m in select m3.request_id, m3.profile_id, m3.chosen
    from public.waitlist_group_members m3 where m3.group_id = g.id
    order by m3.created_at, m3.id
  loop
    v_variant := case when not m.chosen then (case when cardinality(p_request_ids) = 1 then 'not_chosen_one' else 'not_chosen' end)
                      when m.request_id = v_driver_request then 'driver'
                      else 'passenger' end;
    perform public.enqueue_notification(m.profile_id, 'waitlist_resolved', g.department_id, g.week_start,
      jsonb_build_object('names', coalesce(v_chosen_names, ''), 'driverName', coalesce(v_driver_name, ''),
        'car', coalesce(v_car.name, ''), 'day', v_day, 'depart', v_depart, 'return', v_return),
      jsonb_build_object('group_id', g.id, 'request_id', m.request_id, 'day', g.day::text,
        'ride_id', case when m.chosen then v_ride end, 'variant', v_variant),
      format('waitlist_resolved:%s:%s', g.id, m.profile_id));
  end loop;

  for v_sadran in select * from public.sadranim_of(g.department_id, g.week_start) loop
    perform public.enqueue_notification(v_sadran, 'waitlist_resolved', g.department_id, g.week_start,
      jsonb_build_object('names', coalesce(v_chosen_names, ''), 'driverName', coalesce(v_driver_name, ''),
        'car', coalesce(v_car.name, ''), 'day', v_day, 'depart', v_depart, 'return', v_return),
      jsonb_build_object('group_id', g.id, 'day', g.day::text, 'ride_id', v_ride, 'variant', 'sadran'),
      format('waitlist_resolved:%s:sadran:%s', g.id, v_sadran));
  end loop;

  return jsonb_build_object('group_id', g.id, 'ride_id', v_ride, 'car_id', v_car.id,
    'driver_request_id', v_driver_request, 'chosen', to_jsonb(p_request_ids),
    'not_chosen', (select coalesce(jsonb_agg(m4.request_id), '[]')
                   from public.waitlist_group_members m4 where m4.group_id = g.id and m4.chosen = false));
end;
$function$;
