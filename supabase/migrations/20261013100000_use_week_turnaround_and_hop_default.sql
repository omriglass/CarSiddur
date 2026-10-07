-- REQ §13.108 (a) D1: every turnaround read goes through required_turnaround_minutes(dept, week)
-- (week override, else department setting, else 30). Six functions read department_settings directly
-- and ignored a week's settings_overrides. Series functions (move_series, place_series) span weeks and
-- use the largest turnaround of any week the series touches.
-- REQ §13.108 (b) D2 / REQ item 14: unknown travel between two places is 60 minutes
-- (_route_hop_minutes, request_leg_route_minutes, request_stop_etas). The 30-minute TURNAROUND default is unchanged.

CREATE OR REPLACE FUNCTION public."form_waitlist_groups"("p_department_id" "uuid", "p_week_start" "date", "p_day" "date") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_turnaround interval;
  v_clusters jsonb := '[]'::jsonb;
  v_cluster jsonb := '[]'::jsonb;
  v_cluster_end timestamptz;
  v_groups int := 0;
  cand record;
  item jsonb;
  v_lone uuid[] := '{}'; v_id uuid;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  perform public.dissolve_unservable_waitlist_groups(p_department_id, p_week_start, p_day);

  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(p_department_id, p_week_start), 30));

  -- Sweep the day's candidates by departure; because the intervals are half-open
  -- [depart, return + turnaround), "starts before the running cluster ends" is exactly the
  -- transitive-overlap (connected-component) test. Flexibility is deliberately ignored —
  -- the discussion is about the times people actually asked for.
  for cand in
    select q.id, q.depart_at, q.return_at
    from public.requests q
    where q.department_id = p_department_id and q.week_start = p_week_start
      and q.trip_shape = 'round_trip'
      and q.series_id is null                        -- REQ §13.77: series are never grouped
      and not public.request_legs_covered(q.id)       -- REQ §13.100 a: nobody who already holds a ride
      and q.trip_type = 'round_trip'                   -- only members who need a car
      and q.status in ('submitted', 'waitlisted')
      and (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date = p_day
      and not exists (select 1 from public.waitlist_group_members m
                      where m.request_id = q.id and m.chosen is null)
    order by q.depart_at, q.created_at, q.id
  loop
    -- REQ §13.102 (a): a member who starts where no car is free gets the ordinary "no car" path, never a group.
    if not public.request_has_free_car_at_origin(cand.id, true) then
      v_lone := v_lone || cand.id;
      continue;
    end if;
    if jsonb_array_length(v_cluster) = 0 or cand.depart_at >= v_cluster_end then
      if jsonb_array_length(v_cluster) > 0 then
        v_clusters := v_clusters || jsonb_build_array(v_cluster);
      end if;
      v_cluster := jsonb_build_array(cand.id);
      v_cluster_end := cand.return_at + v_turnaround;
    else
      v_cluster := v_cluster || jsonb_build_array(cand.id);
      v_cluster_end := greatest(v_cluster_end, cand.return_at + v_turnaround);
    end if;
  end loop;
  if jsonb_array_length(v_cluster) > 0 then
    v_clusters := v_clusters || jsonb_build_array(v_cluster);
  end if;

  perform set_config('app.waitlist_sweep', 'on', true);
  for item in select * from jsonb_array_elements(v_clusters) loop
    v_groups := v_groups + public.settle_waitlist_cluster(p_department_id, p_week_start, p_day,
      array(select value::uuid from jsonb_array_elements_text(item)));
  end loop;

  foreach v_id in array v_lone loop
    v_groups := v_groups + public.settle_waitlist_cluster(p_department_id, p_week_start, p_day, array[v_id]);
  end loop;

  perform set_config('app.waitlist_sweep', 'off', true);
  return v_groups;
end;
$$;


CREATE OR REPLACE FUNCTION public."join_waitlist_group"("p_request_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_req record; v_day date; v_turnaround interval; v_group uuid; v_other uuid;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null or v_req.trip_shape <> 'round_trip' or v_req.status <> 'waitlisted'
     or v_req.depart_at is null or v_req.return_at is null
     or v_req.series_id is not null                      -- REQ §13.77: series are never grouped
     or v_req.trip_type <> 'round_trip'                  -- REQ §13.100 a: only members who need a car
     or public.request_legs_covered(p_request_id)        -- ...and who hold no ride yet
     or not public.request_has_free_car_at_origin(p_request_id, false) then   -- REQ §13.102 (a): a car must be where they start
    return null;
  end if;
  if exists (select 1 from public.waitlist_group_members m
             where m.request_id = p_request_id and m.chosen is null) then
    return null;
  end if;

  v_day := (v_req.depart_at at time zone 'Asia/Jerusalem')::date;
  if not public.is_day_public(v_req.department_id, v_req.week_start, v_day) then
    return null;
  end if;

  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(v_req.department_id, v_req.week_start), 30));

  select g.id into v_group
  from public.waitlist_groups g
  where g.department_id = v_req.department_id and g.week_start = v_req.week_start
    and g.day = v_day and g.status = 'open'
    and tstzrange(g.starts_at, g.ends_at + v_turnaround, '[)')
        && tstzrange(v_req.depart_at, v_req.return_at + v_turnaround, '[)')
  order by g.starts_at, g.id limit 1
  for update;

  if v_group is not null
     and not (public.request_has_free_car_at_origin(p_request_id, true)
              or exists (select 1 from public.waitlist_group_members gm
                         where gm.group_id = v_group and gm.chosen is null and public.request_has_free_car_at_origin(gm.request_id, true))) then
    return null;
  end if;
  if v_group is not null then
    insert into public.waitlist_group_members (group_id, request_id, profile_id, department_id, week_start,
      depart_at, return_at, adults, child_seats, boosters, destination, origin_name)
    select v_group, v_req.id, v_req.requester_id, v_req.department_id, v_req.week_start,
      v_req.depart_at, v_req.return_at, v_req.adults, v_req.child_seats, v_req.boosters,
      coalesce(d.name, v_req.destination_text),
      case when v_req.origin_id is not distinct from dp.home_destination_id then null
           else coalesce((select o.name from public.destinations o where o.id = v_req.origin_id), v_req.origin_text) end
    from (select 1) x left join public.destinations d on d.id = v_req.destination_id
    left join public.departments dp on dp.id = v_req.department_id;

    perform set_config('app.audit_reason', 'waitlist_group_joined', true);
    update public.waitlist_groups
    set starts_at = least(starts_at, v_req.depart_at), ends_at = greatest(ends_at, v_req.return_at)
    where id = v_group;

    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status_reason = 'WAITLISTED_CONTESTED' where id = p_request_id;
    perform set_config('app.system_status_transition', 'off', true);

    perform public.notify_waitlist_contested(v_group, 'joined', v_req.requester_id);
    return v_group;
  end if;

  select q.id into v_other
  from public.requests q
  where q.department_id = v_req.department_id and q.week_start = v_req.week_start
    and q.id <> p_request_id and q.trip_shape = 'round_trip' and q.status = 'waitlisted'
    and q.series_id is null and q.trip_type = 'round_trip'
    and not public.request_legs_covered(q.id)
    and public.request_has_free_car_at_origin(q.id, false)
    and (q.depart_at at time zone 'Asia/Jerusalem')::date = v_day
    and not exists (select 1 from public.waitlist_group_members m
                    where m.request_id = q.id and m.chosen is null)
    and tstzrange(q.depart_at, q.return_at + v_turnaround, '[)')
        && tstzrange(v_req.depart_at, v_req.return_at + v_turnaround, '[)')
  order by q.created_at, q.id limit 1;

  if v_other is null then return null; end if;
  if not (public.request_has_free_car_at_origin(p_request_id, true) or public.request_has_free_car_at_origin(v_other, true)) then return null; end if;

  v_group := public.create_waitlist_group(v_req.department_id, v_req.week_start, v_day,
    array[v_other, p_request_id]);
  if v_group is null then return null; end if;
  perform public.notify_waitlist_contested(v_group);
  return v_group;
end;
$$;


CREATE OR REPLACE FUNCTION public."move_series"("p_series_id" "uuid", "p_new_car_id" "uuid", "p_expected_version" integer DEFAULT NULL::integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_dept uuid; v_home uuid; v_first timestamptz; v_last timestamptz; v_turnaround interval;
  v_weeks date[]; w date; v_first_ride public.rides%rowtype; v_old_car uuid;
begin
  select (array_agg(q.department_id))[1], min(q.depart_at), max(q.return_at), array_agg(distinct q.week_start)
    into v_dept, v_first, v_last, v_weeks
  from public.requests q where q.series_id = p_series_id and q.status not in ('withdrawn','cancelled');
  if v_dept is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;

  foreach w in array v_weeks loop
    if not public.can_manage_week(v_dept, w) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  end loop;

  select * into v_first_ride from public.rides
  where series_id = p_series_id and status <> 'cancelled' order by starts_at, id limit 1 for update;
  if v_first_ride.id is null then
    return public.place_series(p_series_id, p_new_car_id, true, 'SERIES_PLACED');
  end if;
  if p_expected_version is not null and v_first_ride.version <> p_expected_version then
    perform public.raise_stale_version();
  end if;
  v_old_car := v_first_ride.car_id;
  if v_old_car = p_new_car_id then
    return jsonb_build_object('series_id', p_series_id, 'car_id', p_new_car_id, 'moved', 0);
  end if;

  begin
    if not exists (select 1 from public.cars c
      where c.id = p_new_car_id and c.department_id = v_dept and c.status = 'active' and c.type = 'shared') then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'car_not_shared_active';
    end if;
    if exists (select 1 from public.requests q where q.series_id = p_series_id
      and not public.car_fits(p_new_car_id, q.adults, q.child_seats, q.boosters)) then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'seat_config_violation';
    end if;

    -- A series can span weeks; the span check uses the largest turnaround any of its weeks requires.
    select make_interval(mins => coalesce(max(public.required_turnaround_minutes(v_dept, wk)), 30)) into v_turnaround
    from unnest(v_weeks) as wk;
    select d.home_destination_id into v_home from public.departments d where d.id = v_dept;

    if exists (select 1 from public.rides r
      where r.car_id = p_new_car_id and r.status <> 'cancelled' and not r.planning_conflict
        and r.series_id is distinct from p_series_id
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_first, v_last + v_turnaround, '[)')) then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'car_busy';
    end if;
    if exists (select 1 from public.car_maintenance_blocks b where b.car_id = p_new_car_id
      and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_first, v_last + v_turnaround, '[)')) then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'ride_conflicts_with_maintenance';
    end if;
    if coalesce((select r.destination_id from public.rides r
      where r.car_id = p_new_car_id and r.status <> 'cancelled' and not r.planning_conflict
        and r.series_id is distinct from p_series_id and r.starts_at < v_first
        and not public.ride_is_reservation(r.id)
      order by r.starts_at desc limit 1), v_home) <> v_home then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'car_not_home';
    end if;

    perform set_config('app.audit_reason', 'move_series', true);
    update public.rides set car_id = p_new_car_id where series_id = p_series_id and status <> 'cancelled';

    foreach w in array v_weeks loop
      perform public.refresh_car_turnarounds(p_new_car_id, w);
      perform public.refresh_car_turnarounds(v_old_car, w);
      perform public.assert_car_chain(p_new_car_id, w);
      perform public.assert_car_chain(v_old_car, w);
    end loop;
  exception when others then
    if sqlstate = 'MDR03' then raise; end if;
    raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = sqlerrm;
  end;

  return jsonb_build_object('series_id', p_series_id, 'car_id', p_new_car_id,
    'moved', (select count(*) from public.rides where series_id = p_series_id and status <> 'cancelled'));
end $$;


CREATE OR REPLACE FUNCTION public."place_series"("p_series_id" "uuid", "p_car_id" "uuid", "p_pin" boolean DEFAULT false, "p_pin_reason" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_dept uuid; v_origin uuid; v_dest uuid; v_first timestamptz; v_last timestamptz;
  v_first_week date; v_turnaround interval; v_legs int; v_expected int; v_actor uuid := (select auth.uid());
  v_ride_ids uuid[] := '{}'; v_weeks date[] := '{}';
  leg record; v_ride_id uuid; v_origin_leg uuid; v_destination uuid; v_pin boolean; v_reason text;
  w date;
begin
  begin
    select q.department_id, min(q.depart_at), max(q.return_at), count(*)::int, max(q.series_count)::int
      into v_dept, v_first, v_last, v_legs, v_expected
    from public.requests q
    where q.series_id = p_series_id and q.status not in ('withdrawn','cancelled','denied','external')
    group by q.department_id;
    if v_dept is null or v_legs is distinct from v_expected then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'series_incomplete';
    end if;

    select min(q.week_start) into v_first_week from public.requests q where q.series_id = p_series_id;
    select q.origin_id into v_origin from public.requests q
    where q.series_id = p_series_id order by q.series_index limit 1;
    if v_origin is null then raise exception 'no_home_location' using errcode = 'P0412'; end if;
    select coalesce(q.destination_id, v_origin) into v_dest
    from public.requests q where q.series_id = p_series_id order by q.series_index limit 1;

    if not exists (select 1 from public.cars c
      where c.id = p_car_id and c.department_id = v_dept and c.status = 'active' and c.type = 'shared') then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'car_not_shared_active';
    end if;
    if exists (select 1 from public.requests q where q.series_id = p_series_id
      and not public.car_fits(p_car_id, q.adults, q.child_seats, q.boosters)) then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'seat_config_violation';
    end if;
    -- Every leg on the SAME car: a leg already parked on a different car blocks the move.
    if exists (select 1 from public.rides r
      where r.series_id = p_series_id and r.status <> 'cancelled' and r.car_id <> p_car_id) then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'series_split_across_cars';
    end if;

    -- A series can span weeks; the span check uses the largest turnaround any of its weeks requires.
    select make_interval(mins => coalesce(max(public.required_turnaround_minutes(v_dept, wk.week_start)), 30)) into v_turnaround
    from (select distinct q.week_start from public.requests q
          where q.series_id = p_series_id and q.status not in ('withdrawn','cancelled','denied','external')) wk;

    -- Nobody else uses the car anywhere inside the span.
    if exists (select 1 from public.rides r
      where r.car_id = p_car_id and r.status <> 'cancelled' and not r.planning_conflict
        and r.series_id is distinct from p_series_id
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_first, v_last + v_turnaround, '[)')) then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'car_busy';
    end if;
    if exists (select 1 from public.car_maintenance_blocks b where b.car_id = p_car_id
      and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_first, v_last + v_turnaround, '[)')) then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'ride_conflicts_with_maintenance';
    end if;
    -- The car must be at the series' own origin when the series starts (own legs ignored so
    -- re-runs are idempotent).
    if coalesce((select r.destination_id from public.rides r
      where r.car_id = p_car_id and r.status <> 'cancelled' and not r.planning_conflict
        and r.series_id is distinct from p_series_id and r.starts_at < v_first
        and not public.ride_is_reservation(r.id)
      order by r.starts_at desc limit 1), v_origin) <> v_origin then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'car_not_home';
    end if;

    perform set_config('app.audit_reason', 'place_series', true);
    for leg in select q.* from public.requests q where q.series_id = p_series_id order by q.series_index loop
      v_weeks := v_weeks || leg.week_start;
      if exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                 where rr.request_id = leg.id and r.status <> 'cancelled') then
        continue;                                   -- already placed on p_car_id (checked above)
      end if;
      v_origin_leg  := case when leg.series_index = 1 then v_origin else v_dest end;
      v_destination := case when leg.series_index = leg.series_count then v_origin else v_dest end;
      v_pin    := p_pin or leg.week_start <> v_first_week;
      v_reason := case when leg.week_start <> v_first_week then 'SERIES_CARRY_OVER'
                       else coalesce(p_pin_reason, 'SERIES_PLACED') end;
      insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
        driver_id, status, is_pinned, pin_reason, created_by, series_id)
      values (v_dept, leg.week_start, p_car_id, leg.depart_at, leg.return_at, v_origin_leg, v_destination,
        leg.requester_id,
        case when public.is_week_public(v_dept, leg.week_start) then 'confirmed'::public.ride_status
             else 'draft'::public.ride_status end,
        v_pin, case when v_pin then v_reason else null end, coalesce(v_actor, leg.requester_id), p_series_id)
      returning id into v_ride_id;
      insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
      values (v_ride_id, leg.id, 'driver', 'both', 'keep');
      perform public.assert_ride_seats_fit(v_ride_id);
      v_ride_ids := array_append(v_ride_ids, v_ride_id);
    end loop;

    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'assigned', status_reason = 'SERIES_PLACED' where series_id = p_series_id;
    perform set_config('app.system_status_transition', 'off', true);

    for w in select distinct x from unnest(v_weeks) x order by 1 loop
      perform public.assert_car_chain(p_car_id, w);
    end loop;
  exception when others then
    if sqlstate = 'MDR03' then raise; end if;
    raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = sqlerrm;
  end;

  return jsonb_build_object('series_id', p_series_id, 'car_id', p_car_id,
    'ride_ids', coalesce(to_jsonb(v_ride_ids), '[]'::jsonb),
    'weeks', coalesce(to_jsonb((select array_agg(distinct x order by x) from unnest(v_weeks) x)), '[]'::jsonb));
end $$;


CREATE OR REPLACE FUNCTION public."settle_waitlist_group"("p_group_id" "uuid", "p_request_ids" "uuid"[], "p_actor" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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

  select count(*) filter (where q.has_luggage) into v_lug from public.requests q where q.id = any(p_request_ids);

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
$$;


CREATE OR REPLACE FUNCTION public."try_auto_approve"("p_request_id" "uuid") RETURNS "jsonb"
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


CREATE OR REPLACE FUNCTION public."_route_hop_minutes"("p_from" "uuid", "p_to" "uuid") RETURNS integer
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select case when p_from is null or p_to is null then 60
    else greatest(coalesce((select travel_minutes from public.place_travel(p_from, p_to)), 60), 0) end;
$$;


CREATE OR REPLACE FUNCTION public."request_leg_route_minutes"("p_request_id" "uuid", "p_leg" public."ride_leg") RETURNS integer
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_dept uuid; v_stop_minutes int; v_total int := 0; v_stop_count int;
  v_prev record; v_cur record; v_has_prev boolean := false;
begin
  select department_id into v_dept from public.requests where id = p_request_id;
  if v_dept is null then return null; end if;

  select stop_minutes into v_stop_minutes from public.department_settings where department_id = v_dept;
  v_stop_minutes := coalesce(v_stop_minutes, 5);

  -- REQ §13.97: return-leg stops are inactive while the request has no return.
  select count(*) into v_stop_count from public.request_stops s
  where s.request_id = p_request_id and s.leg = p_leg
    and (p_leg = 'out' or exists (select 1 from public.requests q where q.id = p_request_id and q.return_at is not null));

  for v_cur in select * from public.request_leg_route_points(p_request_id, p_leg) order by "position" loop
    if v_has_prev then
      v_total := v_total + greatest(coalesce(
        case when v_prev.place_id is not null and v_cur.place_id is not null
          then (select travel_minutes from public.place_travel(v_prev.place_id, v_cur.place_id))
        end, 60), 0);
    end if;
    v_prev := v_cur;
    v_has_prev := true;
  end loop;

  return v_total + v_stop_count * v_stop_minutes;
end;
$$;


CREATE OR REPLACE FUNCTION public."request_stop_etas"("p_request_id" "uuid") RETURNS TABLE("leg" public."ride_leg", "position" smallint, "place_id" "uuid", "place_text" "text", "eta" timestamp with time zone)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_req public.requests%rowtype;
  v_stop record;
  v_t timestamptz;
  v_anchor_id uuid; v_anchor_text text;
  v_stop_minutes int;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null then return; end if;
  select stop_minutes into v_stop_minutes from public.department_settings where department_id = v_req.department_id;
  v_stop_minutes := coalesce(v_stop_minutes, 5);

  if v_req.depart_at is not null then
    v_t := v_req.depart_at;
    v_anchor_id := v_req.origin_id; v_anchor_text := v_req.origin_text;
    for v_stop in
      select * from public.request_stops s where s.request_id = p_request_id and s.leg = 'out' order by s."position"
    loop
      v_t := v_t + make_interval(mins => greatest(coalesce(
        case when v_anchor_id is not null and v_stop.place_id is not null
          then (select travel_minutes from public.place_travel(v_anchor_id, v_stop.place_id)) end, 60), 0));
      leg := 'out'; "position" := v_stop."position"; place_id := v_stop.place_id; place_text := v_stop.place_text; eta := v_t;
      return next;
      v_t := v_t + make_interval(mins => v_stop_minutes);
      v_anchor_id := v_stop.place_id; v_anchor_text := v_stop.place_text;
    end loop;
  end if;

  if v_req.return_at is not null then
    v_t := v_req.return_at;
    v_anchor_id := v_req.origin_id; v_anchor_text := v_req.origin_text;  -- final arrival point
    for v_stop in
      select * from public.request_stops s where s.request_id = p_request_id and s.leg = 'return' order by s."position" desc
    loop
      v_t := v_t - make_interval(mins => greatest(coalesce(
        case when v_stop.place_id is not null and v_anchor_id is not null
          then (select travel_minutes from public.place_travel(v_stop.place_id, v_anchor_id)) end, 60), 0));
      leg := 'return'; "position" := v_stop."position"; place_id := v_stop.place_id; place_text := v_stop.place_text; eta := v_t;
      return next;
      v_t := v_t - make_interval(mins => v_stop_minutes);
      v_anchor_id := v_stop.place_id; v_anchor_text := v_stop.place_text;
    end loop;
  end if;
end;
$$;

