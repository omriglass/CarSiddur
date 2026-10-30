-- QA run 16 R16B1/R16B2 (owner 2026-10-30: "a draft takes no space other than what the Sadran sees" - more important
-- than auto-placement): every car-overlap check skips a ride whose time an open draft has taken over (`rides.draft_hold`,
-- 20261030090200), so its old time is free for manual drops, moves, reservations, merges, series moves, swaps and the
-- automatic placement / healing helpers alike, and a ride placed there is not reported as a car overlap
-- (publication_conflict_details). Person checks (is the driver / passenger busy elsewhere) are unchanged.
-- try_auto_approve also leaves an open draft's own car + time alone (_draft_hold_conflict).
-- Each function is its full current definition (schema-current.sql) with only those conditions added.

CREATE OR REPLACE FUNCTION "public"."_apply_proposal_group"("p_proposal_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_group uuid[] := array[p_proposal_id];
  v_more uuid[];
  v_id uuid;
  v_grew boolean := true;
  v_order uuid[];
  v_try integer;
  v_prev_auto text := coalesce(current_setting('app.auto_applying_proposal', true), '');
  v_prev_sst text := coalesce(current_setting('app.system_status_transition', true), '');
  v_prev_applying text := coalesce(current_setting('app.applying_proposal', true), '');
  v_prev_group text := coalesce(current_setting('app.applying_proposal_group', true), '');
  v_prev_swap text := coalesce(current_setting('app.day_car_swap', true), '');
begin
  while v_grew loop
    v_grew := false;
    foreach v_id in array v_group loop
      v_more := array(select x from unnest(public._proposal_blockers(v_id)) x where not (x = any(v_group)));
      if cardinality(v_more) > 0 then
        v_group := v_group || v_more;
        v_grew := true;
      end if;
    end loop;
  end loop;
  if cardinality(v_group) < 2 or exists (select 1 from public.proposals where id = any(v_group) and status <> 'accepted') then
    return false;
  end if;
  v_order := array(select id from public.proposals where id = any(v_group) order by created_at, id);
  for v_try in 1 .. 2 loop
    begin
      set constraints public.rides_no_overlap_per_car deferred;
      perform set_config('app.applying_proposal_group', 'on', true);
      perform set_config('app.auto_applying_proposal', 'on', true);
      perform set_config('app.day_car_swap', 'on', true);
      foreach v_id in array v_order loop
        perform public.apply_proposal(v_id);
      end loop;
      perform set_config('app.day_car_swap', v_prev_swap, true);
      if exists (
        select 1
        from public.proposals p
        join public.ride_requests rr on rr.request_id = p.request_id
        join public.rides r1 on r1.id = rr.ride_id
        join public.rides r2 on r2.car_id = r1.car_id and r2.id <> r1.id
        where p.id = any(v_group) and r1.status <> 'cancelled' and not r1.draft_hold and r2.status <> 'cancelled' and not r2.draft_hold
          and not r1.planning_conflict and not r2.planning_conflict
          and not (r1.series_id is not null and r1.series_id = r2.series_id)
          and tstzrange(r1.starts_at, r1.blocked_until, '[)') && tstzrange(r2.starts_at, r2.blocked_until, '[)')
      ) then
        raise exception 'ride_turnaround_conflict' using errcode = '23P01';
      end if;
      set constraints public.rides_no_overlap_per_car immediate;
      perform set_config('app.auto_applying_proposal', v_prev_auto, true);
      perform set_config('app.applying_proposal_group', v_prev_group, true);
      update public.proposals set waiting_for = '{}'::uuid[] where id = any(v_group) and waiting_for <> '{}'::uuid[];
      return true;
    exception when others then
      set constraints public.rides_no_overlap_per_car immediate;
      perform set_config('app.day_car_swap', v_prev_swap, true);
      perform set_config('app.auto_applying_proposal', v_prev_auto, true);
      perform set_config('app.system_status_transition', v_prev_sst, true);
      perform set_config('app.applying_proposal', v_prev_applying, true);
      perform set_config('app.applying_proposal_group', v_prev_group, true);
    end;
    v_order := array(select x from unnest(v_order) with ordinality t(x, n) order by n desc);
  end loop;
  return false;
end $$;;

CREATE OR REPLACE FUNCTION "public"."_day_car_swap_series_day_blockers"("p_ride_ids" "uuid"[], "p_day" "date", "p_car_a" "uuid", "p_car_b" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_blockers jsonb := '[]'::jsonb;
  r record;
begin
  for r in
    select rd.id as ride_id, o.id as other_id, o.starts_at, o.blocked_until, o.car_id as new_car_id,
           (rd.starts_at at time zone 'Asia/Jerusalem')::date as ride_day,
           (o.starts_at at time zone 'Asia/Jerusalem')::date as other_day,
           c.name as car_name
    from public.rides rd
    join public.rides o
      on o.car_id = (case when rd.car_id = p_car_a then p_car_b else p_car_a end)
     and o.id <> rd.id
    join public.cars c on c.id = o.car_id
    where rd.id = any(p_ride_ids) and rd.status <> 'cancelled' and rd.car_id in (p_car_a, p_car_b)
      and (rd.starts_at at time zone 'Asia/Jerusalem')::date <> p_day
      and o.status <> 'cancelled' and not o.draft_hold
      and not (o.id = any(p_ride_ids))
      and not rd.planning_conflict and not o.planning_conflict
      and tstzrange(rd.starts_at, rd.blocked_until, '[)') && tstzrange(o.starts_at, o.blocked_until, '[)')
    order by rd.starts_at, o.starts_at, o.id
  loop
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'series_other_day_busy', 'whole_only', true,
      'ride_id', r.ride_id, 'car_id', r.new_car_id, 'day', r.other_day,
      'starts_at', r.starts_at, 'ends_at', r.blocked_until,
      'detail', format('%s is busy on %s %s-%s - swap only this day',
        r.car_name, public.day_date_label(r.starts_at),
        to_char(r.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI'),
        to_char(r.blocked_until at time zone 'Asia/Jerusalem', 'HH24:MI'))));
  end loop;
  return v_blockers;
end $$;;

CREATE OR REPLACE FUNCTION "public"."_merge_window_conflict"("_ride_id" "uuid", "_new_start" timestamp with time zone, "_new_end" timestamp with time zone) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare h public.rides%rowtype;
begin
  select * into h from public.rides where id = _ride_id;
  if h.id is null then return false; end if;
  if _new_start >= h.starts_at and _new_end <= h.ends_at then return false; end if;
  return exists(select 1 from public.rides x
    where x.car_id = h.car_id and x.id <> h.id and x.status <> 'cancelled' and not x.draft_hold
      and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(_new_start, _new_end + (h.blocked_until - h.ends_at), '[)'));
end $$;;

CREATE OR REPLACE FUNCTION "public"."_merge_window_conflict_side"("_ride_id" "uuid", "_new_start" timestamp with time zone, "_new_end" timestamp with time zone) RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare h public.rides%rowtype; v_x public.rides%rowtype;
begin
  select * into h from public.rides where id = _ride_id;
  if h.id is null then return null; end if;
  if _new_start >= h.starts_at and _new_end <= h.ends_at then return null; end if;
  select x.* into v_x from public.rides x
    where x.car_id = h.car_id and x.id <> h.id and x.status <> 'cancelled' and not x.draft_hold
      and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(_new_start, _new_end + (h.blocked_until - h.ends_at), '[)')
    order by x.starts_at, x.id limit 1;
  if v_x.id is null then return null; end if;
  return case when v_x.starts_at < h.starts_at then 'previous' else 'next' end;
end $$;;

CREATE OR REPLACE FUNCTION "public"."_proposal_blockers"("p_proposal_id" "uuid") RETURNS "uuid"[]
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select coalesce(array_agg(distinct o.id), '{}'::uuid[])
  from public.proposals p
  cross join lateral public._proposal_car_holds(p.payload, p.type) mine
  cross join lateral (select make_interval(mins => coalesce(public.required_turnaround_minutes(p.department_id, p.week_start), 30)) as buf) b
  join public.rides r on r.car_id = mine.car_id and r.status <> 'cancelled' and not r.draft_hold
    and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(mine.from_at - b.buf, mine.to_at + b.buf, '[)')
  join public.ride_requests rr on rr.ride_id = r.id
  join public.proposals o on o.request_id = rr.request_id and o.id <> p.id and o.request_id <> p.request_id
    and o.department_id = p.department_id and o.week_start = p.week_start and o.status in ('draft', 'sent', 'accepted')
  where p.id = p_proposal_id
$$;;

CREATE OR REPLACE FUNCTION "public"."connect_drop_off_legs"("_car" "uuid", "_week" "date") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_dept uuid; v_turnaround interval; c record; q public.requests%rowtype; v_driver uuid;
  v_os timestamptz; v_oe timestamptz; v_rs timestamptz; v_re timestamptz; v_gap smallint;
  v_t_out int; v_t_ret int; v_prev_flag text;
begin
  select department_id into v_dept from public.cars where id = _car;
  if v_dept is null then return; end if;
  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(v_dept, _week), 30));

  for c in
    select o.request_id, o.ride_id as out_ride, rt.ride_id as ret_ride, (o.manual or rt.manual) as manual
    from (
      select rr.request_id, r.id as ride_id, rr.car_mode, (r.pin_reason = 'SADRAN_MANUAL') as manual
      from public.rides r join public.ride_requests rr on rr.ride_id = r.id
      where r.car_id = _car and r.week_start = _week and r.status <> 'cancelled' and not r.planning_conflict
        and not r.auto_relocation and rr.leg = 'out'
        and (select count(*) from public.ride_requests x where x.ride_id = r.id) = 1
    ) o
    join (
      select rr.request_id, r.id as ride_id, rr.car_mode, (r.pin_reason = 'SADRAN_MANUAL') as manual
      from public.rides r join public.ride_requests rr on rr.ride_id = r.id
      where r.car_id = _car and r.week_start = _week and r.status <> 'cancelled' and not r.planning_conflict
        and not r.auto_relocation and rr.leg = 'return'
        and (select count(*) from public.ride_requests x where x.ride_id = r.id) = 1
    ) rt on rt.request_id = o.request_id
    join public.requests qq on qq.id = o.request_id
    where qq.trip_type = 'drop_off' and qq.trip_shape = 'round_trip'
      and qq.depart_at is not null and qq.return_at is not null
      and qq.origin_id is not null and qq.destination_id is not null
      and (o.car_mode <> 'relay' or rt.car_mode <> 'relay')
    order by qq.depart_at, o.request_id
  loop
    select * into q from public.requests where id = c.request_id;
    v_driver := public.eligible_leg_driver(q.id);
    if v_driver is null then continue; end if; -- a non-driver's legs stay chauffeur rides

    v_t_out := greatest(coalesce(public.request_leg_route_minutes(q.id, 'out'), 30), 0);
    v_t_ret := greatest(coalesce(public.request_leg_route_minutes(q.id, 'return'), 30), 0);
    v_os := q.depart_at;
    v_oe := greatest(public._round_up_ride_end(v_os, v_os + make_interval(mins => v_t_out)), v_os + interval '15 minutes');
    v_re := q.return_at;
    v_rs := to_timestamp(floor(extract(epoch from (v_re - make_interval(mins => v_t_ret))) / 900) * 900);
    if v_rs < v_oe then continue; end if;
    -- REQ §13.103 a / §13.104 a: the wait is needed by others -> two legs, the car returns. A Sadran's own
    -- (manual) placement of either leg is an explicit decision and is never undone by this rule (R4B2).
    -- R5B8 (REQ §13.105): a SHORT wait (<= 2 x turnaround, the §13.104 b threshold) never counts as needed elsewhere:
    -- two chauffeur wraps burn more car time than the wait and leave a member who can drive with two driverless rides.
    -- REQ §13.126 g: "the car is available at the destination" — the member keeps it waiting there on purpose
    -- (trips that start and end there may use it, below); the wait is never handed back for being needed elsewhere.
    if not c.manual and not q.keep_car_at_destination and v_rs - v_oe > 2 * v_turnaround
       and public.car_wait_needed_elsewhere(q.department_id, q.week_start, v_oe, v_rs, array[q.id]) then
      continue;
    end if;

    -- the car must be at the origin when the out leg leaves
    if coalesce((select r.destination_id from public.rides r
                 where r.car_id = _car and r.status <> 'cancelled' and r.starts_at <= v_os and r.id not in (c.out_ride, c.ret_ride)
                   and not public.ride_is_reservation(r.id)
                 order by r.starts_at desc limit 1), public.car_base_location(_car)) is distinct from q.origin_id then continue; end if;
    -- no collision with other rides of the car; between the legs only trips that start and end at the destination
    if exists (
      select 1 from public.rides x
      where x.car_id = _car and x.id not in (c.out_ride, c.ret_ride) and x.status <> 'cancelled' and not x.draft_hold and not x.planning_conflict
        and (tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_os, v_oe + v_turnaround, '[)')
          or tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_rs, v_re + v_turnaround, '[)')
          or (x.starts_at >= v_oe and x.starts_at < v_rs
              and not public.ride_is_reservation(x.id)
              and (x.origin_id is distinct from q.destination_id or x.destination_id is distinct from q.destination_id)))
    ) then continue; end if;

    v_gap := case when v_rs - v_oe < v_turnaround then (extract(epoch from (v_rs - v_oe)) / 60)::smallint end;

    update public.rides set origin_id = q.origin_id, destination_id = q.destination_id,
      starts_at = v_os, ends_at = v_oe, needs_driver = false, driver_id = v_driver,
      turnaround_override_minutes = v_gap,
      pin_reason = case when pin_reason = 'MISSING_DRIVER' then 'CONNECTED_DROP_OFF' else pin_reason end
    where id = c.out_ride;
    update public.rides set origin_id = q.destination_id, destination_id = q.origin_id,
      starts_at = v_rs, ends_at = v_re, needs_driver = false, driver_id = v_driver,
      pin_reason = case when pin_reason = 'MISSING_DRIVER' then 'CONNECTED_DROP_OFF' else pin_reason end
    where id = c.ret_ride;
    update public.ride_requests set role = 'driver', car_mode = 'relay'
    where request_id = q.id and ride_id in (c.out_ride, c.ret_ride);

    v_prev_flag := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'assigned', status_reason = 'RELAY_CONNECTED'
    where id = q.id and status is distinct from 'assigned';
    perform set_config('app.system_status_transition', v_prev_flag, true);
  end loop;
end $$;;

CREATE OR REPLACE FUNCTION "public"."edit_ride_before_series"("p_ride" "jsonb", "p_expected_version" integer DEFAULT NULL::integer) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare existing public.rides%rowtype; v_id uuid:=nullif(p_ride->>'id','')::uuid;
  v_dept uuid:=(p_ride->>'department_id')::uuid; v_week date:=(p_ride->>'week_start')::date;
  v_car uuid:=(p_ride->>'car_id')::uuid; v_start timestamptz:=(p_ride->>'starts_at')::timestamptz;
  v_end timestamptz:=(p_ride->>'ends_at')::timestamptz; wants_planning boolean:=coalesce((p_ride->>'allow_conflict')::boolean,false);
  collision boolean; old_setting text:=coalesce(current_setting('app.coordinator_planning',true),''); result uuid; leg record;
begin
  if not public.is_approved() then raise exception 'not_authorized'; end if;
  if wants_planning and not public.can_manage_week(v_dept,v_week) then raise exception 'not_authorized'; end if;
  perform public.assert_same_day_window(v_start,v_end);
  if not(public.week_range(v_week) @> tstzrange(v_start,v_end,'[)')) then raise exception 'ride_outside_week'; end if;
  if v_id is not null then
    select * into existing from public.rides where id=v_id for update;
    if not found or existing.status='cancelled' then raise exception 'ride_not_found'; end if;
    if existing.department_id<>v_dept or existing.week_start<>v_week then raise exception 'not_authorized'; end if;
    if p_expected_version is null or existing.version<>p_expected_version then perform public.raise_stale_version(); end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_car::text,0));
  select exists(select 1 from public.rides r where r.car_id=v_car and r.id is distinct from v_id and r.status<>'cancelled' and not r.draft_hold
    and tstzrange(r.starts_at,r.ends_at,'[)') && tstzrange(v_start,v_end,'[)')) into collision;
  if wants_planning and collision and existing.id is not null and existing.status<>'draft' then
    if exists(select 1 from public.weeks where department_id=v_dept and week_start=v_week and phase='archived') then raise exception 'week_archived'; end if;
    if not exists(select 1 from public.cars where id=v_car and department_id=v_dept and status='active'
      and (type='shared' or owner_id=existing.driver_id)) then raise exception 'car_unavailable'; end if;
    if (v_start at time zone 'Asia/Jerusalem')::date<>(existing.starts_at at time zone 'Asia/Jerusalem')::date then raise exception 'ride_request_day_mismatch'; end if;
    if not public.is_quarter_hour(v_start) or not(public.is_quarter_hour(v_end) or public.is_same_day_end(v_end)) then raise exception 'invalid_ride_window'; end if;
    if exists(select 1 from public.car_maintenance_blocks b where b.car_id=v_car
      and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(v_start,v_end,'[)')) then raise exception 'ride_conflicts_with_maintenance'; end if;
    -- Seat counts already include request owners. Add the volunteer only if not
    -- represented in this leg; never double count a driver/requester.
    for leg in select side,sum(q.adults)::int adults,sum(q.child_seats)::int children,sum(q.boosters)::int boosters,
      bool_or(q.requester_id=existing.driver_id) driver_included
      from public.ride_requests rr join public.requests q on q.id=rr.request_id
      cross join lateral(values('out'),('return')) legs(side)
      where rr.ride_id=v_id and ((side='out' and rr.covers_out) or (side='return' and rr.covers_return)) group by side loop
      if not public.car_fits(v_car,leg.adults+case when coalesce(leg.driver_included,false) then 0 else 1 end,leg.children,leg.boosters) then raise exception 'seat_config_violation'; end if;
    end loop;
    if exists(select 1 from public.ride_change_requests where ride_id=v_id and status='pending' and not is_planning) then raise exception 'ride_change_already_pending'; end if;
    update public.ride_change_requests set status='cancelled' where ride_id=v_id and status='pending' and is_planning;
    insert into public.ride_change_requests(department_id,week_start,requester_id,ride_id,car_id,starts_at,ends_at,expected_version,is_planning)
      values(v_dept,v_week,(select auth.uid()),v_id,v_car,v_start,v_end,existing.version,true);
    return v_id;
  end if;
  perform set_config('app.coordinator_planning',case when wants_planning then 'on' else '' end,true);
  result:=public.edit_ride_before_planning(p_ride,p_expected_version);
  perform set_config('app.coordinator_planning',old_setting,true);
  -- A successful placement resolves its saved private shadow, if any.
  update public.ride_change_requests set status='cancelled' where ride_id=result and status='pending' and is_planning;
  return result;
end $$;;

CREATE OR REPLACE FUNCTION "public"."extend_chauffeur_pickup_drive"("_car" "uuid", "_week" "date") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_dept uuid; v_turnaround interval; v_dwell int; c record;
  v_t1 int; v_t3 int; v_route int; v_start timestamptz; v_end timestamptz;
begin
  select department_id into v_dept from public.cars where id = _car;
  if v_dept is null then return; end if;
  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(v_dept, _week), 30));
  select coalesce((w.settings_overrides ->> 'chauffeur_dwell_minutes')::int, s.chauffeur_dwell_minutes, 10) into v_dwell
  from public.department_settings s left join public.weeks w on w.department_id = s.department_id and w.week_start = _week
  where s.department_id = v_dept;
  v_dwell := greatest(coalesce(v_dwell, 10), 0);

  for c in
    select r.id as ride_id, r.starts_at, r.ends_at, r.origin_id as place, q.id as request_id, q.depart_at, q.origin_id, q.destination_id
    from public.rides r
    join public.ride_requests rr on rr.ride_id = r.id
    join public.requests q on q.id = rr.request_id
    where r.car_id = _car and r.week_start = _week and r.status <> 'cancelled' and not r.planning_conflict and not r.auto_relocation
      and r.pin_reason is distinct from 'SADRAN_MANUAL'
      and rr.car_mode = 'chauffeur' and rr.leg = 'out'
      and (select count(*) from public.ride_requests x where x.ride_id = r.id) = 1
      and q.origin_id is not null and q.destination_id is not null and q.depart_at is not null
      and r.origin_id is distinct from q.origin_id
    order by r.starts_at
  loop
    select p.travel_minutes into v_t1 from public.place_travel(c.place, c.origin_id) p;
    continue when v_t1 is null;
    select p.travel_minutes into v_t3 from public.place_travel(c.destination_id, c.place) p;
    v_route := greatest(coalesce(public.request_leg_route_minutes(c.request_id, 'out'), 30), 0);
    v_start := to_timestamp(floor(extract(epoch from (c.depart_at - make_interval(mins => v_t1 + v_dwell))) / 900) * 900);
    v_end := greatest(c.ends_at, to_timestamp(ceil(extract(epoch from (c.depart_at + make_interval(mins => v_route + coalesce(v_t3, 0)))) / 900) * 900));
    continue when c.starts_at <= v_start and c.ends_at >= v_end;
    v_start := least(v_start, c.starts_at);
    continue when (v_start at time zone 'Asia/Jerusalem')::date <> (c.starts_at at time zone 'Asia/Jerusalem')::date
      or ((v_end - interval '1 minute') at time zone 'Asia/Jerusalem')::date <> (c.starts_at at time zone 'Asia/Jerusalem')::date;
    continue when exists (
      select 1 from public.rides x
      where x.car_id = _car and x.id <> c.ride_id and x.status <> 'cancelled' and not x.draft_hold and not x.planning_conflict
        and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_start, v_end + v_turnaround, '[)'))
      or exists (
      select 1 from public.car_maintenance_blocks b
      where b.car_id = _car and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_start, v_end, '[)'));
    update public.rides set starts_at = v_start, ends_at = v_end where id = c.ride_id;
  end loop;
end $$;;

CREATE OR REPLACE FUNCTION "public"."freed_slot_candidates"("_offer" "uuid") RETURNS TABLE("request_id" "uuid", "requester_id" "uuid", "fits" boolean, "slack" interval)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
   and not exists (select 1 from rides r2 where r2.car_id = o.car_id and r2.status <> 'cancelled' and not r2.draft_hold
        and r2.id <> o.cancelled_ride_id and not r2.planning_conflict
        and tstzrange(r2.starts_at, r2.blocked_until, '[)') && tstzrange(q.depart_at, q.return_at, '[)'))
   -- REQ §13.114: a scheduled maintenance period on the freed car (also one added after the offer was
   -- made) is never offered, incl. the turnaround buffer before it.
   and not exists (select 1 from car_maintenance_blocks b where b.car_id = o.car_id
        and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(q.depart_at,
          q.return_at + make_interval(mins => coalesce(public.required_turnaround_minutes(o.department_id, o.week_start), 30)), '[)'))
  where o.id = _offer and o.status = 'open'
    -- RC1B3: the people a Sadran cancelled this ride on and kept on the waiting list are not offered its own car
    and q.id <> all(o.excluded_request_ids)
    and cr.origin_id = cr.destination_id
    and public.car_fits(o.car_id, q.adults, q.child_seats, q.boosters)
    and public.car_takes_luggage(o.car_id, case when q.has_luggage and q.luggage_waived_at is null then 1 else 0 end)
  order by slack asc, q.submitted_at asc;
$$;;

CREATE OR REPLACE FUNCTION "public"."join_drop_off_legs"("p_request_id" "uuid", "p_ride_id" "uuid", "p_expected_version" integer, "p_allow_small_trunk" boolean DEFAULT false) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  q public.requests%rowtype; v_given public.rides%rowtype; o public.rides%rowtype; r public.rides%rowtype;
  v_out uuid; v_ret uuid; v_cand uuid; v_try int; v_turnaround interval; v_driver uuid;
  v_actor uuid := (select auth.uid());
begin
  perform public._small_trunk_mode(p_allow_small_trunk);   -- REQ §13.111 (a)
  select * into q from public.requests where id = p_request_id;
  select * into v_given from public.rides where id = p_ride_id for update;
  if q.id is null or v_given.id is null or v_given.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if q.department_id <> v_given.department_id or q.week_start <> v_given.week_start
     or not public.can_manage_week(v_given.department_id, v_given.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_expected_version is null or v_given.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if exists (select 1 from public.weeks w where w.department_id = q.department_id and w.week_start = q.week_start and w.phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  if q.trip_type is distinct from 'drop_off' or q.trip_shape is distinct from 'round_trip' then
    raise exception 'join_legs_not_drop_off' using errcode = 'P0001';
  end if;

  select rr.ride_id into v_out from public.ride_requests rr join public.rides x on x.id = rr.ride_id
  where rr.request_id = q.id and rr.leg = 'out' and rr.car_mode = 'chauffeur' and x.status <> 'cancelled' order by x.starts_at limit 1;
  select rr.ride_id into v_ret from public.ride_requests rr join public.rides x on x.id = rr.ride_id
  where rr.request_id = q.id and rr.leg = 'return' and rr.car_mode = 'chauffeur' and x.status <> 'cancelled' order by x.starts_at desc limit 1;
  if v_out is null or v_ret is null or v_out = v_ret or p_ride_id not in (v_out, v_ret) then
    raise exception 'join_legs_not_two_rides' using errcode = 'P0001';
  end if;
  select * into o from public.rides where id = v_out for update;
  select * into r from public.rides where id = v_ret for update;
  if exists (select 1 from public.ride_requests x where x.ride_id in (o.id, r.id) and x.request_id <> q.id) then
    raise exception 'join_legs_shared_ride' using errcode = 'P0001';
  end if;
  if o.driver_id is not null and r.driver_id is not null and o.driver_id <> r.driver_id then
    raise exception 'join_legs_two_drivers' using errcode = 'P0001';
  end if;
  if r.starts_at < o.ends_at
     or (o.starts_at at time zone 'Asia/Jerusalem')::date <> ((r.ends_at - interval '1 minute') at time zone 'Asia/Jerusalem')::date then
    raise exception 'join_legs_order' using errcode = 'P0001';
  end if;

  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(q.department_id, q.week_start), 30));
  v_cand := null;
  for v_try in 1..2 loop
    if v_try = 1 then v_cand := o.car_id;
    elsif r.car_id <> o.car_id and r.origin_id = o.origin_id and public.car_location_excluding(r.car_id, o.starts_at, r.id) = o.origin_id then v_cand := r.car_id;
    else v_cand := null; end if;
    continue when v_cand is null;
    if public.car_fits(v_cand, q.adults + 1, q.child_seats, q.boosters)
       and not exists (
         select 1 from public.rides x
         where x.car_id = v_cand and x.id not in (o.id, r.id) and x.status <> 'cancelled' and not x.draft_hold and not x.planning_conflict
           and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(o.starts_at, r.ends_at + v_turnaround, '[)'))
       and not exists (
         select 1 from public.car_maintenance_blocks b
         where b.car_id = v_cand and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(o.starts_at, r.ends_at, '[)'))
    then exit; end if;
    v_cand := null;
  end loop;
  if v_cand is null then raise exception 'join_legs_car_busy' using errcode = 'P0001'; end if;

  perform set_config('app.audit_reason', 'join_drop_off_legs', true);
  v_driver := coalesce(o.driver_id, r.driver_id);
  delete from public.ride_requests where ride_id = r.id and request_id = q.id;
  update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = coalesce(v_actor, created_by),
    cancel_reason = 'JOINED_BY_SADRAN' where id = r.id;
  update public.ride_requests set leg = 'both' where ride_id = o.id and request_id = q.id;
  update public.rides set car_id = v_cand, ends_at = r.ends_at, turnaround_override_minutes = null,
    driver_id = v_driver, needs_driver = (v_driver is null), is_pinned = true,
    pin_reason = coalesce(pin_reason, 'SADRAN_MANUAL')
  where id = o.id;
  perform public.assert_ride_seats_fit(o.id);
  perform public.assert_car_chain(v_cand, q.week_start);
  if o.car_id <> v_cand then perform public.assert_car_chain(o.car_id, q.week_start); end if;
  if r.car_id <> v_cand and r.car_id <> o.car_id then perform public.assert_car_chain(r.car_id, q.week_start); end if;
  return o.id;
end $$;;

CREATE OR REPLACE FUNCTION "public"."merge_short_drop_off_rides"("_car" "uuid", "_week" "date") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_dept uuid; v_turnaround interval; v_limit interval; c record; q public.requests%rowtype;
  v_cand uuid; v_try int; v_cars uuid[];
begin
  select department_id into v_dept from public.cars where id = _car;
  if v_dept is null then return; end if;
  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(v_dept, _week), 30));
  v_limit := v_turnaround * 2;

  for c in
    select o.request_id, o.ride_id as out_ride, o.car_id as out_car, o.starts_at as o_start, o.ends_at as o_end, o.origin_id as o_place,
           rt.ride_id as ret_ride, rt.car_id as ret_car, rt.starts_at as r_start, rt.ends_at as r_end, rt.origin_id as r_place
    from (
      select rr.request_id, r.id as ride_id, r.car_id, r.starts_at, r.ends_at, r.origin_id
      from public.rides r join public.ride_requests rr on rr.ride_id = r.id
      where r.week_start = _week and r.department_id = v_dept and r.status <> 'cancelled' and not r.planning_conflict and not r.auto_relocation
        and r.needs_driver and r.driver_id is null and r.pin_reason is distinct from 'SADRAN_MANUAL'
        and rr.leg = 'out' and rr.car_mode = 'chauffeur'
        and (select count(*) from public.ride_requests x where x.ride_id = r.id) = 1
    ) o
    join (
      select rr.request_id, r.id as ride_id, r.car_id, r.starts_at, r.ends_at, r.origin_id
      from public.rides r join public.ride_requests rr on rr.ride_id = r.id
      where r.week_start = _week and r.department_id = v_dept and r.status <> 'cancelled' and not r.planning_conflict and not r.auto_relocation
        and r.needs_driver and r.driver_id is null and r.pin_reason is distinct from 'SADRAN_MANUAL'
        and rr.leg = 'return' and rr.car_mode = 'chauffeur'
        and (select count(*) from public.ride_requests x where x.ride_id = r.id) = 1
    ) rt on rt.request_id = o.request_id
    join public.requests qq on qq.id = o.request_id
    where (o.car_id = _car or rt.car_id = _car)
      and qq.trip_type = 'drop_off' and qq.trip_shape = 'round_trip'
      and rt.starts_at >= o.ends_at and rt.starts_at - o.ends_at <= v_limit
      and (o.starts_at at time zone 'Asia/Jerusalem')::date = ((rt.ends_at - interval '1 minute') at time zone 'Asia/Jerusalem')::date
    order by o.starts_at, o.request_id
  loop
    select * into q from public.requests where id = c.request_id;
    if public.car_wait_needed_elsewhere(v_dept, _week, c.o_end, c.r_start, array[q.id]) then continue; end if;

    v_cand := null;
    for v_try in 1..2 loop
      if v_try = 1 then v_cand := c.out_car;
      elsif c.ret_car <> c.out_car and c.r_place = c.o_place and public.car_location_excluding(c.ret_car, c.o_start, c.ret_ride) = c.o_place then v_cand := c.ret_car;
      else v_cand := null; end if;
      continue when v_cand is null;
      if public.car_fits(v_cand, q.adults + 1, q.child_seats, q.boosters)
         and not exists (
           select 1 from public.rides x
           where x.car_id = v_cand and x.id not in (c.out_ride, c.ret_ride) and x.status <> 'cancelled' and not x.draft_hold and not x.planning_conflict
             and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(c.o_start, c.r_end + v_turnaround, '[)'))
         and not exists (
           select 1 from public.car_maintenance_blocks b
           where b.car_id = v_cand and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(c.o_start, c.r_end, '[)'))
      then exit; end if;
      v_cand := null;
    end loop;
    continue when v_cand is null;

    delete from public.ride_requests where ride_id = c.ret_ride and request_id = q.id;
    update public.rides set status = 'cancelled', cancelled_at = now(),
      cancelled_by = coalesce((select auth.uid()), created_by), cancel_reason = 'MERGED_SHORT_DROP_OFF'
    where id = c.ret_ride;
    update public.ride_requests set leg = 'both' where ride_id = c.out_ride and request_id = q.id;
    update public.rides set car_id = v_cand, ends_at = c.r_end, turnaround_override_minutes = null where id = c.out_ride;
    v_cars := array[c.out_car, c.ret_car];
    for v_try in 1..2 loop
      if v_cars[v_try] <> _car and (v_try = 1 or v_cars[1] <> v_cars[2]) then
        perform public.assert_car_chain(v_cars[v_try], _week);
      end if;
    end loop;
  end loop;
end $$;;

CREATE OR REPLACE FUNCTION "public"."move_series"("p_series_id" "uuid", "p_new_car_id" "uuid", "p_expected_version" integer DEFAULT NULL::integer) RETURNS "jsonb"
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
      where r.car_id = p_new_car_id and r.status <> 'cancelled' and not r.draft_hold and not r.planning_conflict
        and r.series_id is distinct from p_series_id
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_first, v_last + v_turnaround, '[)')) then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'car_busy';
    end if;
    if exists (select 1 from public.car_maintenance_blocks b where b.car_id = p_new_car_id
      and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_first, v_last + v_turnaround, '[)')) then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'ride_conflicts_with_maintenance';
    end if;
    if coalesce((select r.destination_id from public.rides r
      where r.car_id = p_new_car_id and r.status <> 'cancelled' and not r.draft_hold and not r.planning_conflict
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
end $$;;

CREATE OR REPLACE FUNCTION "public"."pair_one_way_legs"("p_dept" "uuid", "p_week" "date") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_turnaround interval; v_travel int;
  out_leg record; ret_leg record;
  v_driver_out uuid; v_driver_ret uuid;
  v_out_start timestamptz; v_out_end timestamptz; v_ret_start timestamptz; v_ret_end timestamptz;
  v_target_car uuid; v_cand uuid; v_try int;
  v_gap_override smallint;
  v_out_load record; v_ret_load record;
  v_prev_flag text;
begin
  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(p_dept, p_week), 30));

  for out_leg in
    select r.id as ride_id, r.car_id, r.driver_id, r.needs_driver, (r.is_pinned and r.pin_reason is distinct from 'MISSING_DRIVER') as is_pinned,
           (r.pin_reason = 'SADRAN_MANUAL') as manual, rr.request_id, q.origin_id, q.destination_id, q.depart_at
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

    select x.ride_id, x.car_id, x.request_id, x.ret_start, x.ret_end, x.is_pinned, x.manual into ret_leg
    from (
      select r2.id as ride_id, r2.car_id, q2.id as request_id, (r2.is_pinned and r2.pin_reason is distinct from 'MISSING_DRIVER') as is_pinned,
             (r2.pin_reason = 'SADRAN_MANUAL') as manual,
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
      select r2.id, r2.car_id, q2.id, (r2.is_pinned and r2.pin_reason is distinct from 'MISSING_DRIVER'), (r2.pin_reason = 'SADRAN_MANUAL'),
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

    -- REQ §13.104 a (R4Q1): two different members' legs park the car at X only when nobody else needs a car
    -- during the wait (the §13.103 a rule); a Sadran's own manual placement of either leg is never undone.
    if not (out_leg.manual or ret_leg.manual)
       and public.car_wait_needed_elsewhere(p_dept, p_week, v_out_end, ret_leg.ret_start, array[out_leg.request_id, ret_leg.request_id]) then
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
    -- Candidate cars in preference order: the shared one; the out-leg's car (return leg moves there); the
    -- return leg's car (out-leg moves there). A pinned leg never moves; a car with an intervening ride that
    -- leaves the meeting place is never a pairing car.
    for v_try in 1..3 loop
      v_cand := null;
      if v_try = 1 then
        if out_leg.car_id = ret_leg.car_id then v_cand := out_leg.car_id; end if;
      elsif v_try = 2 then
        if out_leg.car_id <> ret_leg.car_id and not ret_leg.is_pinned
          and public.car_fits(out_leg.car_id, v_out_load.adults, v_out_load.child_seats, v_out_load.boosters)
          and public.car_fits(out_leg.car_id, v_ret_load.adults, v_ret_load.child_seats, v_ret_load.boosters)
          and not exists (
            select 1 from public.rides x where x.car_id = out_leg.car_id and x.id not in (out_leg.ride_id, ret_leg.ride_id)
              and x.status <> 'cancelled' and not x.draft_hold and not x.planning_conflict
              and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_ret_start, v_ret_end + v_turnaround, '[)'))
        then v_cand := out_leg.car_id; end if;
      else
        if out_leg.car_id <> ret_leg.car_id and not out_leg.is_pinned
          and public.car_fits(ret_leg.car_id, v_out_load.adults, v_out_load.child_seats, v_out_load.boosters)
          and public.car_fits(ret_leg.car_id, v_ret_load.adults, v_ret_load.child_seats, v_ret_load.boosters)
          and not exists (
            select 1 from public.rides x where x.car_id = ret_leg.car_id and x.id not in (out_leg.ride_id, ret_leg.ride_id)
              and x.status <> 'cancelled' and not x.draft_hold and not x.planning_conflict
              and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_out_start, v_out_end + v_turnaround, '[)'))
        then v_cand := ret_leg.car_id; end if;
      end if;
      continue when v_cand is null;
      continue when exists (
        select 1 from public.rides x
        where x.car_id = v_cand and x.id not in (out_leg.ride_id, ret_leg.ride_id)
          and x.status <> 'cancelled' and not x.draft_hold and not x.planning_conflict and not public.ride_is_reservation(x.id)
          and x.starts_at >= v_out_end and x.starts_at < v_ret_start
          and (x.origin_id is distinct from out_leg.destination_id or x.destination_id is distinct from out_leg.destination_id));
      v_target_car := v_cand; exit;
    end loop;
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
end $$;;

CREATE OR REPLACE FUNCTION "public"."place_on_own_car"("p_request_id" "uuid", "p_car_id" "uuid", "p_allow_small_trunk" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_req public.requests%rowtype; v_actor uuid := (select auth.uid()); v_car public.cars%rowtype;
  v_ride uuid; v_by text; v_prop uuid; v_phase public.week_phase; v_turnaround int;
begin
  perform public._small_trunk_mode(p_allow_small_trunk);   -- REQ §13.111 (a)
  select * into v_req from public.requests where id = p_request_id for update;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  -- REQ §13.127 (c): the owner may also put a request they filed for someone else (or are related to) on their car.
  if v_req.requester_id is distinct from v_actor and not public.request_related(p_request_id, v_actor) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  select * into v_car from public.cars where id = p_car_id;
  if v_car.id is null or v_car.department_id <> v_req.department_id then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if v_car.type <> 'temporary' or v_car.owner_id is distinct from v_actor then raise exception 'private_car_owner_only' using errcode = 'P0001'; end if;
  if v_car.status <> 'active' then raise exception 'car_unavailable' using errcode = 'P0001'; end if;
  if v_req.status in ('assigned', 'merged', 'withdrawn', 'cancelled') or v_req.series_id is not null
     or exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                where rr.request_id = p_request_id and r.status <> 'cancelled') then
    raise exception 'request_not_editable' using errcode = 'P0001';
  end if;
  if v_req.trip_type <> 'round_trip' or v_req.depart_at is null or v_req.return_at is null or v_req.origin_id is null then
    raise exception 'own_car_round_trip_only' using errcode = 'P0001';
  end if;
  if v_req.depart_at < now() then raise exception 'ride_in_past' using errcode = 'P0001'; end if;
  select phase into v_phase from public.weeks where department_id = v_req.department_id and week_start = v_req.week_start;
  if v_phase is null or v_phase in ('archived', 'upcoming') then raise exception 'week_archived' using errcode = 'P0001'; end if;
  v_turnaround := coalesce(public.required_turnaround_minutes(v_req.department_id, v_req.week_start), 30);
  if exists (select 1 from public.rides r where r.car_id = p_car_id and r.status <> 'cancelled' and not r.draft_hold
             and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_req.depart_at, v_req.return_at + make_interval(mins => v_turnaround), '[)'))
     or exists (select 1 from public.car_maintenance_blocks b where b.car_id = p_car_id
             and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_req.depart_at, v_req.return_at, '[)')) then
    raise exception 'own_car_not_free' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'place_on_own_car', true);
  for v_prop in
    select p.id from public.proposals p
    where p.status in ('draft', 'sent')
      and (p.request_id = p_request_id or exists (select 1 from public.proposal_parties pp where pp.proposal_id = p.id and pp.request_id = p_request_id))
    for update
  loop
    update public.proposals set status = 'withdrawn' where id = v_prop;
  end loop;

  perform set_config('app.system_status_transition', 'on', true);
  v_ride := public.place_request_on_car(p_request_id, p_car_id, false, v_actor, null, null, null, 'OWN_CAR');
  perform set_config('app.system_status_transition', 'off', true);

  select full_name into v_by from public.profiles where id = v_actor;
  perform public.enqueue_notification(s.profile_id, 'outcome_changed', v_req.department_id, v_req.week_start,
    jsonb_build_object('byName', coalesce(v_by, ''), 'route', coalesce(public.request_route_label(p_request_id), ''),
      'day', public.day_date_label(v_req.depart_at), 'car', v_car.name),
    jsonb_build_object('variant', 'own_car_placed', 'request_id', p_request_id, 'ride_id', v_ride,
      'url', format('/sadran/%s/%s/board', v_req.department_id, v_req.week_start)),
    format('own_car_placed:%s:%s', p_request_id, s.profile_id))
  from public.sadranim_of(v_req.department_id, v_req.week_start) as s(profile_id)
  where s.profile_id is distinct from v_actor;

  return jsonb_build_object('request_id', p_request_id, 'ride_id', v_ride, 'status', 'assigned', 'car_id', p_car_id);
end $$;;

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
          or exists(select 1 from public.rides r where r.car_id = v_car and r.status <> 'cancelled' and not r.draft_hold
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
$$;;

CREATE OR REPLACE FUNCTION "public"."place_series"("p_series_id" "uuid", "p_car_id" "uuid", "p_pin" boolean DEFAULT false, "p_pin_reason" "text" DEFAULT NULL::"text") RETURNS "jsonb"
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
      where r.car_id = p_car_id and r.status <> 'cancelled' and not r.draft_hold and not r.planning_conflict
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
      where r.car_id = p_car_id and r.status <> 'cancelled' and not r.draft_hold and not r.planning_conflict
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
end $$;;

CREATE OR REPLACE FUNCTION "public"."prepare_manual_ride_window"("p_car_id" "uuid", "p_week_start" "date", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_ride_id" "uuid" DEFAULT NULL::"uuid") RETURNS smallint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_car_id::text,0));
  -- REQ §13.138 (f): a swap applied as one group checks overlap and turnaround on the final state (_apply_proposal_group).
  if coalesce(current_setting('app.day_car_swap',true),'')='on' then return null; end if;
  if coalesce(current_setting('app.coordinator_planning',true),'')='on'
    and exists(select 1 from public.cars c where c.id=p_car_id and public.can_manage_week(c.department_id,p_week_start))
    and exists(select 1 from public.rides r where r.car_id=p_car_id and r.id is distinct from p_ride_id and r.status<>'cancelled' and not r.draft_hold
      and tstzrange(r.starts_at,r.ends_at,'[)') && tstzrange(p_starts_at,p_ends_at,'[)')) then return 0; end if;
  return public.prepare_manual_ride_window_before_planning(p_car_id,p_week_start,p_starts_at,p_ends_at,p_ride_id);
end $$;;

CREATE OR REPLACE FUNCTION "public"."prepare_manual_ride_window_before_planning"("p_car_id" "uuid", "p_week_start" "date", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_ride_id" "uuid" DEFAULT NULL::"uuid") RETURNS smallint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare required int; next_start timestamptz; result smallint; previous record;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_car_id::text,0));
  if p_ends_at<=p_starts_at then raise exception 'invalid_ride_window'; end if;
  if exists(select 1 from public.rides where car_id=p_car_id and id is distinct from p_ride_id and status<>'cancelled' and not draft_hold
    and tstzrange(starts_at,ends_at,'[)') && tstzrange(p_starts_at,p_ends_at,'[)')) then
    raise exception 'ride_time_overlap' using errcode='23P01';
  end if;
  select public.required_turnaround_minutes(c.department_id,p_week_start) into required from public.cars c where c.id=p_car_id;
  for previous in select * from public.rides where car_id=p_car_id and id is distinct from p_ride_id and status<>'cancelled' and not draft_hold
    and ends_at<=p_starts_at and blocked_until>p_starts_at order by starts_at for update loop
    update public.rides set turnaround_override_minutes=(extract(epoch from(p_starts_at-previous.ends_at))/60)::smallint where id=previous.id;
  end loop;
  select min(starts_at) into next_start from public.rides where car_id=p_car_id and id is distinct from p_ride_id and status<>'cancelled' and not draft_hold and starts_at>=p_ends_at;
  if next_start is not null and p_ends_at+make_interval(mins=>required)>next_start then result:=(extract(epoch from(next_start-p_ends_at))/60)::smallint; end if;
  return result;
end $$;;

CREATE OR REPLACE FUNCTION "public"."publication_conflict_details"("p_department_id" "uuid", "p_week_start" "date", "p_days" "date"[]) RETURNS TABLE("ride_id" "uuid", "reason" "text", "other_ride_id" "uuid")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare r record; here uuid; res boolean; o uuid; nxt uuid;
begin
  for r in
    select * from public.rides where department_id=p_department_id and week_start=p_week_start and status<>'cancelled'
      and (starts_at at time zone 'Asia/Jerusalem')::date=any(p_days)
  loop
    res:=public.ride_is_reservation(r.id);
    ride_id:=r.id; other_ride_id:=null;
    if r.starts_at>=r.ends_at or (r.starts_at at time zone 'Asia/Jerusalem')::date<>(r.ends_at at time zone 'Asia/Jerusalem')::date
      or (r.ends_at at time zone 'Asia/Jerusalem')::time>'23:59'::time
      or (r.starts_at at time zone 'Asia/Jerusalem')::date not between p_week_start and p_week_start+6 then
      reason:='bad_window'; other_ride_id:=null; return next;
    end if;
    select other.id into o from public.rides other where other.id<>r.id and other.status<>'cancelled' and not other.draft_hold and not r.draft_hold and other.car_id=r.car_id
      and tstzrange(other.starts_at,other.ends_at,'[)') && tstzrange(r.starts_at,r.ends_at,'[)') order by other.starts_at limit 1;
    if o is not null then reason:='car_overlap'; other_ride_id:=o; return next; end if;
    other_ride_id:=null;
    if exists(select 1 from public.car_maintenance_blocks b where b.car_id=r.car_id
      and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(r.starts_at,r.ends_at,'[)')) then reason:='maintenance'; return next; end if;
    if not exists(select 1 from public.cars c where c.id=r.car_id and c.department_id=p_department_id and c.status='active') then
      reason:='car_unavailable'; return next;
    end if;
    if not res then
      select prev.id, prev.destination_id into o, here from public.rides prev
        where prev.car_id=r.car_id and prev.status<>'cancelled' and (prev.starts_at,prev.id)<(r.starts_at,r.id)
          and not public.ride_is_reservation(prev.id)
        order by prev.starts_at desc,prev.id desc limit 1;
      if o is null then here:=public.car_base_location(r.car_id); end if;
      if r.origin_id is distinct from here then reason:='car_not_at_origin'; other_ride_id:=o; return next; end if;
      other_ride_id:=null;
      select nx.id into nxt from public.rides nx
        where nx.car_id=r.car_id and nx.week_start=p_week_start and nx.status<>'cancelled' and (nx.starts_at,nx.id)>(r.starts_at,r.id)
          and not public.ride_is_reservation(nx.id)
        order by nx.starts_at,nx.id limit 1;
      if nxt is not null and exists(select 1 from public.rides f where f.id=nxt and f.origin_id is distinct from r.destination_id) then
        reason:='next_ride_not_here'; other_ride_id:=nxt; return next; other_ride_id:=null;
      end if;
    end if;
    begin perform public.assert_ride_request_day(r.id);
    exception when raise_exception or check_violation then reason:='request_day'; return next; end;
    begin perform public.assert_ride_driver(r.id);
    exception when raise_exception or check_violation then reason:='driver'; return next; end;
    begin perform public.assert_ride_seats_fit(r.id);
    exception when raise_exception or check_violation then reason:='seats'; return next; end;
  end loop;
  -- pending provisional (planning) edits on a live ride block too; a cancelled ride's shadow is not a ride to show.
  return query select distinct c.ride_id, 'planning_edit'::text, null::uuid from public.ride_change_requests c
    join public.rides rr on rr.id=c.ride_id and rr.status<>'cancelled'
    where c.department_id=p_department_id and c.week_start=p_week_start and c.status='pending'
      and coalesce((to_jsonb(c)->>'is_planning')::boolean,false)
      and (c.starts_at at time zone 'Asia/Jerusalem')::date=any(p_days);
end;
$$;;

CREATE OR REPLACE FUNCTION "public"."request_has_free_car_at_origin"("p_request_id" "uuid", "p_strict" boolean) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
        not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled' and not r.draft_hold and not r.planning_conflict
          and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(q.depart_at, coalesce(q.return_at, q.depart_at + interval '1 hour') + v_ta, '[)'))
        and not exists (select 1 from public.car_maintenance_blocks b where b.car_id = c.id
          and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(q.depart_at, coalesce(q.return_at, q.depart_at + interval '1 hour'), '[)')))));
end $$;;

CREATE OR REPLACE FUNCTION "public"."request_ride_change"("p_ride_id" "uuid", "p_car_id" "uuid", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_expected_version" integer, "p_allow_small_trunk" boolean DEFAULT false) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare r public.rides%rowtype; other public.rides%rowtype; ch uuid; buffer interval; cnt int:=0;
begin
  select * into r from public.rides where id=p_ride_id for update;
  if not found then raise exception 'ride_not_found'; end if;
  if not public.is_approved() or r.driver_id is distinct from (select auth.uid()) or not public.is_week_public(r.department_id,r.week_start) then raise exception 'not_authorized'; end if;
  if r.status='cancelled' or r.version<>p_expected_version then perform public.raise_stale_version(); end if;
  -- REQ §13.128 (a): a ride of today may still change (the day itself must stay the same, below).
  if (r.starts_at at time zone 'Asia/Jerusalem')::date < (now() at time zone 'Asia/Jerusalem')::date or p_ends_at<=p_starts_at or (p_starts_at at time zone 'Asia/Jerusalem')::date<>(r.starts_at at time zone 'Asia/Jerusalem')::date then raise exception 'ride_request_day_mismatch'; end if;
  if not (public.week_range(r.week_start) @> tstzrange(p_starts_at,p_ends_at,'[)')) then raise exception 'ride_outside_week'; end if;
  if exists(select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=r.id and (q.requester_id<>r.driver_id or rr.car_mode='relay')) then raise exception 'shared_ride_requires_sadran'; end if;
  -- REQ §13.111 (a): the driver may accept a car without a large trunk for their own large-luggage request(s); the
  -- waiver is stamped only when the change is accepted (respond_ride_change_before_planning).
  perform public._small_trunk_check(array(select rr.request_id from public.ride_requests rr where rr.ride_id=r.id), p_car_id, p_allow_small_trunk);
  perform 1 from public.cars where id=p_car_id and department_id=r.department_id and status='active' and type='shared' for update;
  if not found then raise exception 'car_unavailable'; end if;
  select make_interval(mins=>coalesce((w.settings_overrides->>'turnaround_minutes')::int,s.turnaround_minutes)) into buffer
  from public.department_settings s join public.weeks w on w.department_id=s.department_id where w.department_id=r.department_id and w.week_start=r.week_start;
  if exists(select 1 from public.car_maintenance_blocks where car_id=p_car_id and tstzrange(starts_at,ends_at,'[)') && tstzrange(p_starts_at,p_ends_at+buffer,'[)')) then raise exception 'ride_conflicts_with_maintenance'; end if;
  update public.ride_change_requests set status='cancelled' where ride_id=r.id and status='pending';
  insert into public.ride_change_requests(department_id,week_start,requester_id,ride_id,car_id,starts_at,ends_at,expected_version,allow_small_trunk)
  values(r.department_id,r.week_start,(select auth.uid()),r.id,p_car_id,p_starts_at,p_ends_at,r.version,coalesce(p_allow_small_trunk,false)) returning id into ch;
  for other in select * from public.rides where car_id=p_car_id and id<>r.id and status<>'cancelled' and not draft_hold
    and tstzrange(starts_at,blocked_until,'[)') && tstzrange(p_starts_at,p_ends_at+buffer,'[)') order by id for update loop
    if other.driver_id is null or other.driver_id=r.driver_id or other.origin_id<>other.destination_id
      or exists(select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=other.id and q.requester_id<>other.driver_id)
    then raise exception 'shared_ride_requires_sadran'; end if;
    insert into public.ride_change_parties(change_id,ride_id,profile_id,expected_version) values(ch,other.id,other.driver_id,other.version);
    perform public.enqueue_notification(other.driver_id,'proposal_received',r.department_id,r.week_start,
      jsonb_build_object('requesterName',(select full_name from public.profiles where id=r.driver_id),
        'date',to_char(p_starts_at at time zone 'Asia/Jerusalem','DD/MM/YY'),
        'depart',to_char(p_starts_at at time zone 'Asia/Jerusalem','HH24:MI'),'return',to_char(p_ends_at at time zone 'Asia/Jerusalem','HH24:MI')),
      jsonb_build_object('ride_change_id',ch,'ride_id',other.id,'url','/inbox?change='||ch),format('ride_change:%s:%s',ch,other.driver_id));
    cnt:=cnt+1;
  end loop;
  if cnt=0 then raise exception 'no_conflicting_ride'; end if;
  return ch;
end $$;;

CREATE OR REPLACE FUNCTION "public"."reserve_live_one_way_slot"("p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare q public.requests%rowtype; c record; dwell int; duration_minutes int; travel int;
  start_time timestamptz; end_time timestamptz; buffer_minutes int; ride_id uuid;
  pickup_start timestamptz; pickup_end timestamptz;
  v_start timestamptz; v_end timestamptz; v_loc uuid;
  week_from timestamptz; week_until timestamptz; request_day date;
begin
  select * into q from public.requests where id=p_request_id for update;
  if not found or q.requester_id is distinct from (select auth.uid()) or not public.member_of(q.department_id)
    or q.trip_shape='round_trip' or q.trip_type is distinct from 'drop_off' or not exists(select 1 from public.weeks where department_id=q.department_id and week_start=q.week_start and phase='live')
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
        or exists(select 1 from public.rides r where r.car_id=c.id and r.status<>'cancelled' and not r.draft_hold
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
end $$;;

CREATE OR REPLACE FUNCTION "public"."settle_waitlist_group"("p_group_id" "uuid", "p_request_ids" "uuid"[], "p_actor" "uuid") RETURNS "jsonb"
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

  select count(*) filter (where q.has_luggage and q.luggage_waived_at is null) into v_lug from public.requests q where q.id = any(p_request_ids);

  -- REQ §13.101 (i): a car freed for this group (held offer) is the first choice.
  select c.* into v_car from public.cars c join public.freed_slot_offers fo on fo.car_id = c.id
  where fo.group_id = g.id and fo.status = 'open'
    and c.status = 'active' and c.type = 'shared'
    and public.car_fits(c.id, v_adults, v_child_seats, v_boosters)
    and public.car_takes_luggage(c.id, v_lug)
    and public.car_location_at(c.id, v_starts) = v_home
    and not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled' and not r.draft_hold
      and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_starts, v_ends + v_turnaround, '[)'))
  order by c.id limit 1;

  if v_car.id is null and v_preferred is not null then
    select c.* into v_car from public.cars c
    where c.id = v_preferred and c.department_id = g.department_id
      and c.status = 'active' and c.type = 'shared'
      and public.car_fits(c.id, v_adults, v_child_seats, v_boosters)
      and public.car_takes_luggage(c.id, v_lug)
      and public.car_location_at(c.id, v_starts) = v_home
      and not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled' and not r.draft_hold
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_starts, v_ends + v_turnaround, '[)'));
  end if;
  if v_car.id is null then
    select c.* into v_car from public.cars c
    where c.department_id = g.department_id and c.status = 'active' and c.type = 'shared'
      and public.car_fits(c.id, v_adults, v_child_seats, v_boosters)
      and public.car_takes_luggage(c.id, v_lug)
      and public.car_location_at(c.id, v_starts) = v_home
      and not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled' and not r.draft_hold
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
$$;;

CREATE OR REPLACE FUNCTION "public"."swap_day_cars"("p_department_id" "uuid", "p_week_start" "date", "p_day" "date", "p_car_a" "uuid", "p_car_b" "uuid", "p_expected_fingerprint" "text", "p_series_mode" "text" DEFAULT 'whole'::"text", "p_allow_small_trunk" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := (select auth.uid());
  v_day_ids uuid[];
  v_series_ids uuid[];
  v_moving uuid[];
  v_auth_blockers jsonb;
  v_phys_blockers jsonb;
  v_notices jsonb;
  v_old_car_names jsonb;
  v_fp text;
  v_sid uuid;
  v_weeks date[];
  w date;
  v_notified int := 0;
  v_moved int := 0;
  v_person record;
  v_hard jsonb; v_soft jsonb;
begin
  perform public._small_trunk_mode(p_allow_small_trunk);
  if p_series_mode not in ('whole', 'day') then
    raise exception 'invalid_series_mode' using errcode = 'P0001';
  end if;

  v_auth_blockers := public._day_car_swap_authorize(p_department_id, p_week_start, p_day, p_car_a, p_car_b, v_actor);
  if jsonb_array_length(v_auth_blockers) > 0 then
    raise exception 'not_authorized' using errcode = 'P0001', detail = v_auth_blockers::text;
  end if;

  v_day_ids := public._day_car_swap_day_ride_ids(p_department_id, p_week_start, p_day, p_car_a, p_car_b);
  v_fp := public._day_car_swap_fingerprint(v_day_ids);
  if p_expected_fingerprint is null or v_fp <> p_expected_fingerprint then
    perform public.raise_stale_version();
  end if;

  v_series_ids := public._day_car_swap_series_ids(v_day_ids);

  if p_series_mode = 'whole' then
    v_moving := public._day_car_swap_expand_whole(v_day_ids);
  else
    v_moving := v_day_ids;   -- 'day': only the swapped day's own legs change car
  end if;

  v_phys_blockers := public._day_car_swap_private_car_blockers(p_car_a, p_car_b, v_actor)
    || public._day_car_swap_physical_blockers(v_moving, p_car_a, p_car_b);
  if p_series_mode = 'whole' then
    v_phys_blockers := v_phys_blockers || public._day_car_swap_series_day_blockers(v_moving, p_day, p_car_a, p_car_b);
  end if;
  -- REQ §13.111 (a): a luggage blocker is waivable; everything else still refuses.
  select coalesce(jsonb_agg(b), '[]'::jsonb) into v_hard from jsonb_array_elements(v_phys_blockers) b
  where not coalesce((b ->> 'waivable')::boolean, false);
  select coalesce(jsonb_agg(b), '[]'::jsonb) into v_soft from jsonb_array_elements(v_phys_blockers) b
  where coalesce((b ->> 'waivable')::boolean, false);
  if jsonb_array_length(v_hard) > 0 then
    raise exception 'day_car_swap_blocked' using errcode = 'P0001', detail = (v_hard -> 0)::text;
  end if;
  if jsonb_array_length(v_soft) > 0 and not coalesce(p_allow_small_trunk, false) then
    raise exception 'needs_large_trunk' using errcode = 'P0001', detail = public._small_trunk_detail(
      (select array_agg(distinct (rid)::uuid) from jsonb_array_elements(v_soft) s, jsonb_array_elements_text(s -> 'request_ids') rid),
      (v_soft -> 0 ->> 'car_id')::uuid);
  end if;

  v_notices := case when coalesce(array_length(v_day_ids, 1), 0) > 0
    then public._day_car_swap_notices(v_day_ids, p_car_a, p_car_b, p_day)
    else '[]'::jsonb end;

  -- capture each moving ride's pre-swap car name for the `fromCar` notification var.
  select jsonb_object_agg(r.id::text, c.name) into v_old_car_names
  from public.rides r join public.cars c on c.id = r.car_id
  where r.id = any(v_moving);

  perform set_config('app.audit_reason', 'swap_day_cars', true);

  if p_series_mode = 'day' then
    foreach v_sid in array v_series_ids loop
      perform public._day_car_swap_split_series(v_sid, p_day);
    end loop;
  end if;

  -- One UPDATE exchanges the two cars. Two per-row checks would false-positive mid-statement
  -- whenever both cars have rides at the same time (the ordinary case): the overlap
  -- exclusion constraint and rides_before_write's neighbour/turnaround check both compare a
  -- moved row with the other car's not-yet-moved row. So, scoped to this statement only:
  -- the exclusion constraint is deferred (DEFERRABLE INITIALLY IMMEDIATE, top of this file)
  -- and `app.day_car_swap` makes rides_before_write skip its neighbour checks; the same
  -- checks then run on the final state right after — no table lock, no trigger disabling.
  set constraints public.rides_no_overlap_per_car deferred;
  perform set_config('app.day_car_swap', 'on', true);
  update public.rides
  set car_id = case when car_id = p_car_a then p_car_b else p_car_a end
  where id = any(v_moving) and car_id in (p_car_a, p_car_b);
  perform set_config('app.day_car_swap', 'off', true);
  if exists (
    select 1
    from public.rides r1
    join public.rides r2 on r2.car_id = r1.car_id and r2.id <> r1.id
    where r1.id = any(v_moving)
      and r1.status <> 'cancelled' and not r1.draft_hold and r2.status <> 'cancelled' and not r2.draft_hold
      and not r1.planning_conflict and not r2.planning_conflict
      and not (r1.series_id is not null and r1.series_id = r2.series_id)
      and tstzrange(r1.starts_at, r1.blocked_until, '[)') && tstzrange(r2.starts_at, r2.blocked_until, '[)')
  ) then
    raise exception 'ride_turnaround_conflict' using errcode = '23P01';
  end if;
  begin
    set constraints public.rides_no_overlap_per_car immediate;
  exception when exclusion_violation then
    -- Safety net: never leak the raw exclusion error (REQ §13.92, 2026-10-16).
    raise exception 'day_car_swap_blocked' using errcode = 'P0001', detail = jsonb_build_object('code', 'overlap')::text;
  end;

  v_moved := coalesce(array_length(v_moving, 1), 0);

  select coalesce(array_agg(distinct week_start), array[p_week_start]) into v_weeks
  from public.rides where id = any(v_moving);

  foreach w in array v_weeks loop
    perform public.assert_car_chain(p_car_a, w);
    perform public.assert_car_chain(p_car_b, w);
  end loop;

  if public.is_day_public(p_department_id, p_week_start, p_day) and coalesce(array_length(v_day_ids, 1), 1) > 0 then
    for v_person in
      select distinct (pe ->> 'person_id')::uuid as person_id, vbr.id as ride_id
      from public.v_board_rides vbr
      cross join lateral jsonb_array_elements(vbr.people) pe
      where vbr.id = any(v_day_ids) and pe ->> 'person_id' is not null
    loop
      if v_person.person_id is distinct from v_actor then
        perform public.enqueue_notification(v_person.person_id, 'car_swapped', p_department_id, p_week_start,
          jsonb_build_object('fromCar', coalesce(v_old_car_names ->> v_person.ride_id::text, '')),
          jsonb_build_object('ride_id', v_person.ride_id),
          format('car_swapped:%s:%s', v_person.ride_id, v_person.person_id));
        v_notified := v_notified + 1;
      end if;
    end loop;
  end if;

  return jsonb_build_object('moved_rides', v_moved, 'notified', v_notified, 'notices', v_notices);
end $$;;

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
  v_offer uuid;
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
        where r.car_id = c.id and r.status <> 'cancelled' and not r.draft_hold
          and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_req.depart_at, v_end + v_turnaround, '[)')
      )
      and not public._draft_hold_conflict(c.id, v_req.depart_at, v_end + v_turnaround, array[v_req.id])
      -- REQ §13.114: never inside a scheduled maintenance period (incl. the turnaround buffer before it).
      and not exists (
        select 1 from public.car_maintenance_blocks b
        where b.car_id = c.id
          and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_req.depart_at, v_end + v_turnaround, '[)')
      )
      and (not v_is_one_way or public.car_week_end_ok(c.id, v_end, v_req.destination_id))   -- REQ §13.136 c: no next ride -> the base
      -- R15B10: a car an open contested group's member could take stays theirs; the newcomer joins the group instead.
      and not public.car_held_by_waitlist_group(c.id, v_req.depart_at, v_end + v_turnaround, p_request_id)
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
        where r.car_id = c.id and r.status <> 'cancelled' and not r.draft_hold
          and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_req.depart_at, v_end + v_turnaround, '[)')
      )
      and not public._draft_hold_conflict(c.id, v_req.depart_at, v_end + v_turnaround, array[v_req.id])
      -- REQ §13.114: never inside a scheduled maintenance period (incl. the turnaround buffer before it).
      and not exists (
        select 1 from public.car_maintenance_blocks b
        where b.car_id = c.id
          and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_req.depart_at, v_end + v_turnaround, '[)')
      )
      and (not v_is_one_way or public.car_week_end_ok(c.id, v_end, v_req.destination_id))   -- REQ §13.136 c: no next ride -> the base
      -- R15B10: a car an open contested group's member could take stays theirs; the newcomer joins the group instead.
      and not public.car_held_by_waitlist_group(c.id, v_req.depart_at, v_end + v_turnaround, p_request_id)
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
    -- REQ §13.157: an open group this request could join is offered, never joined for them.
    v_offer := public.waitlist_group_offer(p_request_id);
    if v_offer is not null then
      return jsonb_build_object('status', 'waitlisted', 'reason', 'WAITLISTED_NO_CAR', 'group_offer', v_offer);
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
$$;;

CREATE OR REPLACE FUNCTION "public"."try_widen_one_way_leg"("p_ride_id" "uuid", "p_car" "uuid", "p_dept" "uuid", "p_week" "date", "p_home" "uuid", "p_turnaround" interval, "p_direction" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
  v_prev_flag text; v_pinned boolean;
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
  v_pinned := v_ride.is_pinned and v_ride.pin_reason is distinct from 'MISSING_DRIVER';  -- automatic reservations stay healable

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
        and (not v_pinned or c.id = p_car)
      order by (c.id = p_car) desc, c.id
    loop
      if public.car_location_excluding(v_candidate, v_start_a, p_ride_id) = v_origin
        and public.car_fits(v_candidate, v_adults + 1, v_child_seats, v_boosters)
        and not exists (
          select 1 from public.rides x
          where x.car_id = v_candidate and x.id <> p_ride_id and x.status <> 'cancelled' and not x.draft_hold and not x.planning_conflict
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
          and (not v_pinned or c.id = p_car)
        order by (c.id = p_car) desc, c.id
      loop
        if public.car_location_excluding(v_candidate, v_start_b, p_ride_id) = v_dest
          and public.car_fits(v_candidate, v_adults + 1, v_child_seats, v_boosters)
          and not exists (
            select 1 from public.rides x
            where x.car_id = v_candidate and x.id <> p_ride_id and x.status <> 'cancelled' and not x.draft_hold and not x.planning_conflict
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
      where x.car_id = v_car_id and x.id <> p_ride_id and x.status <> 'cancelled' and not x.draft_hold and not x.planning_conflict
        and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_start, v_end + p_turnaround, '[)')
    ) then
      v_car_id := null;
      for v_candidate in
        select c.id from public.cars c
        where c.department_id = p_dept and c.status = 'active' and c.type = 'shared' and c.id <> p_car and not v_pinned
        order by c.id
      loop
        if public.car_fits(v_candidate, v_adults + 1, v_child_seats, v_boosters) and not exists (
          select 1 from public.rides x
          where x.car_id = v_candidate and x.status <> 'cancelled' and not x.draft_hold and not x.planning_conflict
            and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_start, v_end + p_turnaround, '[)')
        ) then
          v_car_id := v_candidate;
          exit;
        end if;
      end loop;
    end if;
  end if;

  if v_start >= v_end then v_end := v_start + interval '15 minutes'; end if;

  if v_car_id is null and v_pinned then
    -- QB4: a Sadran-placed ride is never cancelled or moved: it keeps its car and window and now needs a driver.
    v_loc := case when public.car_location_excluding(p_car, v_ride.starts_at, p_ride_id) in (v_origin, v_dest)
                  then public.car_location_excluding(p_car, v_ride.starts_at, p_ride_id) else v_origin end;
    update public.rides set needs_driver = true, driver_id = null, turnaround_override_minutes = null,
      origin_id = v_loc, destination_id = v_loc where id = p_ride_id;
    update public.ride_requests set role = 'passenger', car_mode = 'chauffeur' where ride_id = p_ride_id and request_id = v_request_id;
    v_prev_flag := coalesce(current_setting('app.system_status_transition', true), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'waitlisted', status_reason = 'UNMET_NEEDS_DRIVER' where id = v_request_id;
    perform set_config('app.system_status_transition', v_prev_flag, true);
    if v_was_active then
      perform public.enqueue_notification(v_requester, 'outcome_changed', p_dept, p_week,
        '{}'::jsonb, jsonb_build_object('request_id', v_request_id),
        format('outcome_changed:%s:%s', v_request_id, now()));
    end if;
    return 'needs_driver';
  end if;

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
end $$;;

CREATE OR REPLACE FUNCTION "public"."waitlist_group_holding"("p_car_id" "uuid", "p_from" timestamp with time zone, "p_until" timestamp with time zone, "p_request_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_dept uuid; v_week date; v_ta interval; v_group uuid;
begin
  select department_id, week_start into v_dept, v_week from public.requests where id = p_request_id;
  if v_dept is null then return null; end if;
  v_ta := make_interval(mins => coalesce(public.required_turnaround_minutes(v_dept, v_week), 30));
  select g.id into v_group
    from public.waitlist_groups g
    join public.waitlist_group_members gm on gm.group_id = g.id and gm.chosen is null and gm.request_id <> p_request_id
    join public.requests q on q.id = gm.request_id and q.status = 'waitlisted'
    where g.department_id = v_dept and g.week_start = v_week and g.status = 'open'
      -- a member of this group competes inside it, never against its own group
      and not exists (select 1 from public.waitlist_group_members me
                      where me.group_id = g.id and me.request_id = p_request_id and me.chosen is null)
      and tstzrange(q.depart_at, q.return_at + v_ta, '[)') && tstzrange(p_from, p_until, '[)')
      and q.origin_id is not null and public.car_location_at(p_car_id, q.depart_at) = q.origin_id
      and public.car_fits(p_car_id, q.adults, q.child_seats, q.boosters)
      and public.car_takes_luggage(p_car_id, case when q.has_luggage and q.luggage_waived_at is null then 1 else 0 end)
      and not exists (select 1 from public.rides r where r.car_id = p_car_id and r.status <> 'cancelled' and not r.draft_hold and not r.planning_conflict
                      and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(q.depart_at, q.return_at + v_ta, '[)'))
      -- REQ §13.158: during an edit the editor's own old booking still occupies its car — a car that was not free for
      -- the member before the edit is not held against the editor (keeping or shrinking one's hours is never blocked).
      and not exists (select 1 from jsonb_array_elements(coalesce(nullif(current_setting('app.edit_kept_rides', true), ''), '[]')::jsonb) k
                      where (k ->> 'car')::uuid = p_car_id
                        and tstzrange((k ->> 'from')::timestamptz, (k ->> 'until')::timestamptz, '[)') && tstzrange(q.depart_at, q.return_at + v_ta, '[)'))
      and not exists (select 1 from public.car_maintenance_blocks b where b.car_id = p_car_id
                      and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(q.depart_at, q.return_at, '[)'))
  order by g.starts_at, g.id limit 1;
  return v_group;
end $$;;

CREATE OR REPLACE FUNCTION "public"."waitlist_group_holds"("p_department_id" "uuid", "p_week_start" "date") RETURNS TABLE("group_id" "uuid", "car_id" "uuid", "held_from" timestamp with time zone, "held_until" timestamp with time zone, "gap_from" timestamp with time zone, "gap_until" timestamp with time zone)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_ta interval;
begin
  if not (public.member_of(p_department_id) or public.is_admin()) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_ta := make_interval(mins => coalesce(public.required_turnaround_minutes(p_department_id, p_week_start), 30));
  return query
  with held as (
    select g.id as gid, g.day, c.id as cid, min(q.depart_at) as h_from, max(q.return_at) as h_until
    from public.waitlist_groups g
    join public.waitlist_group_members gm on gm.group_id = g.id and gm.chosen is null
    join public.requests q on q.id = gm.request_id and q.status = 'waitlisted' and q.origin_id is not null
    join public.cars c on c.department_id = g.department_id and c.type = 'shared' and c.status = 'active'
    where g.department_id = p_department_id and g.week_start = p_week_start and g.status = 'open'
      and public.car_location_at(c.id, q.depart_at) = q.origin_id
      and public.car_fits(c.id, q.adults, q.child_seats, q.boosters)
      and public.car_takes_luggage(c.id, case when q.has_luggage and q.luggage_waived_at is null then 1 else 0 end)
      and not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled' and not r.draft_hold and not r.planning_conflict
                      and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(q.depart_at, q.return_at + v_ta, '[)'))
      and not exists (select 1 from public.car_maintenance_blocks b where b.car_id = c.id
                      and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(q.depart_at, q.return_at, '[)'))
    group by g.id, g.day, c.id)
  select h.gid, h.cid, h.h_from, h.h_until,
    greatest(((h.day + time '06:00') at time zone 'Asia/Jerusalem'),
             coalesce((select max(r.blocked_until) from public.rides r where r.car_id = h.cid and r.status <> 'cancelled' and not r.draft_hold
                       and not r.planning_conflict and r.blocked_until <= h.h_from), '-infinity'::timestamptz)),
    least(((h.day + time '23:59') at time zone 'Asia/Jerusalem'),
          coalesce((select min(r.starts_at) - v_ta from public.rides r where r.car_id = h.cid and r.status <> 'cancelled' and not r.draft_hold
                    and not r.planning_conflict and r.starts_at >= h.h_until), 'infinity'::timestamptz))
  from held h
  order by h.gid, h.cid;
end $$;;
