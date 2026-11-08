-- REQ §13.200: every automatic placement path puts a towing request only on a car with the hitch (and at most one
-- towing request per ride), exactly where it already keeps large luggage on a large-trunk car. Waived requests
-- (luggage_waived_at) count as needing neither. Bodies copied whole from the current definitions (schema-current.sql).

CREATE OR REPLACE FUNCTION "public"."_auto_approve_free_car"("p_request_id" "uuid", "p_end" timestamp with time zone, "p_after" interval, "p_turnaround" interval, "p_pref" "uuid", "p_is_one_way" boolean) RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select c.id
  from public.requests q
  join public.cars c on c.department_id = q.department_id
  join public.car_seat_configs csc on csc.car_id = c.id
  where q.id = p_request_id and c.status = 'active' and c.type = 'shared'
    and csc.adults >= q.adults and csc.child_seats >= q.child_seats and csc.boosters >= q.boosters
    and (not (q.has_luggage and q.luggage_waived_at is null) or 'large_trunk' = any(c.features))
    and (not (q.needs_tow_hitch and q.luggage_waived_at is null) or 'tow_hitch' = any(c.features))   -- REQ §13.200
    and public.car_location_at(c.id, q.depart_at) = q.origin_id
    and not exists (
      select 1 from public.rides r
      where r.car_id = c.id and r.status <> 'cancelled' and not r.draft_hold
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(q.depart_at, p_end + p_after, '[)')
    )
    and not public._draft_hold_conflict(c.id, q.depart_at, p_end + p_turnaround, array[q.id])
    -- REQ §13.114: never inside a scheduled maintenance period (incl. the turnaround buffer before it).
    and not exists (
      select 1 from public.car_maintenance_blocks b
      where b.car_id = c.id
        and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(q.depart_at, p_end + p_turnaround, '[)')
    )
    and (not p_is_one_way or public.car_week_end_ok(c.id, p_end, q.destination_id))   -- REQ §13.136 c: no next ride -> the base
    -- R15B10: a car an open contested group's member could take stays theirs; the newcomer joins the group instead.
    and not public.car_held_by_waitlist_group(c.id, q.depart_at, p_end + p_turnaround, p_request_id)
  order by (c.id = p_pref) desc nulls last, c.id
  limit 1;
$$;

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
      and public.car_meets_needs(c.id, case when q.has_luggage and q.luggage_waived_at is null then 1 else 0 end, case when q.needs_tow_hitch and q.luggage_waived_at is null then 1 else 0 end)
      and public.car_location_at(c.id, q.depart_at) = q.origin_id
      and (not p_strict or (
        not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled' and not r.draft_hold and not r.planning_conflict
          and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(q.depart_at, coalesce(q.return_at, q.depart_at + interval '1 hour') + v_ta, '[)'))
        and not exists (select 1 from public.car_maintenance_blocks b where b.car_id = c.id
          and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(q.depart_at, coalesce(q.return_at, q.depart_at + interval '1 hour'), '[)')))));
end $$;

CREATE OR REPLACE FUNCTION "public"."freed_slot_candidates"("_offer" "uuid") RETURNS TABLE("request_id" "uuid", "requester_id" "uuid", "fits" boolean, "slack" interval)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  with o as (
    select fo.*, cr.origin_id as cr_origin
    from freed_slot_offers fo join rides cr on cr.id = fo.cancelled_ride_id
    where fo.id = _offer and fo.status = 'open' and cr.origin_id = cr.destination_id
  ),
  pool as (
    -- the waiting list, as before (a plan B waiting for its driver is read with its main trip below)
    -- REQ §13.193: a one-leg הקפצה (drop-off only or pickup only) is read as its chauffeur ride at its own time
    select q.id, q.requester_id, q.adults, q.child_seats, q.boosters, q.has_luggage, q.needs_tow_hitch, q.luggage_waived_at,
      case when q.trip_type = 'drop_off' and q.depart_at is null
           then q.return_at - make_interval(mins => public.chauffeur_ride_minutes(q.id, 'return'))
           else q.depart_at end as dep,
      case when q.trip_type = 'drop_off' and q.return_at is null
           then q.depart_at + make_interval(mins => public.chauffeur_ride_minutes(q.id, 'out'))
           else q.return_at end as ret,
      q.origin_id, q.origin_text, q.submitted_at
    from o join requests q
      on q.department_id = o.department_id and q.week_start = o.week_start
     and q.status in ('waitlisted','denied','external') and not q.served_by_alternative
     and (q.trip_shape = 'round_trip' or q.trip_type = 'drop_off')   -- one-way requests are never auto-placed (REQ §13.64); a הקפצה is (§13.193)
     and q.series_id is null                             -- REQ §13.77: a multi-day series never fits a one-day freed slot
     -- R2B3: a request that already holds one leg is only a candidate for a הקפצה (the missing leg is placed alone)
     and (q.trip_type = 'drop_off' or cardinality(public.request_covered_legs(q.id)) = 0)
    where not q.freed_slot_opt_out
    union all
    -- REQ §13.168: served by its plan B; its main trip is a round trip
    select q.id, q.requester_id, q.adults, q.child_seats, q.boosters, q.has_luggage, q.needs_tow_hitch, q.luggage_waived_at,
      (a.original_main ->> 'depart_at')::timestamptz, (a.original_main ->> 'return_at')::timestamptz,
      q.origin_id, q.origin_text, q.submitted_at
    from o join requests q
      on q.department_id = o.department_id and q.week_start = o.week_start
     -- any live plan B: placed, riding with someone, or its chauffeur ride still waiting for a driver
     and q.status in ('assigned', 'merged', 'waitlisted') and q.served_by_alternative and q.series_id is null and q.plan_b_parent_id is null
    join request_alternatives a on a.request_id = q.id and a.original_main is not null
    where not q.freed_slot_opt_out and a.original_main ->> 'trip_type' = 'round_trip'
      and a.original_main ->> 'depart_at' is not null and a.original_main ->> 'return_at' is not null
  )
  select p.id, p.requester_id,
         public.car_fits(o.car_id, p.adults, p.child_seats, p.boosters) as fits,
         (o.ends_at - o.starts_at) - (p.ret - p.dep) as slack
  from o join pool p on true
  -- REQ §13.102 (b): the request's own times lie inside the car's free gap, and it starts where the car is
  where p.dep >= o.starts_at and p.ret <= o.ends_at
    and (p.origin_id = o.cr_origin or (p.origin_id is null and p.origin_text is null))
    and not exists (select 1 from rides r2 where r2.car_id = o.car_id and r2.status <> 'cancelled' and not r2.draft_hold
         and r2.id <> o.cancelled_ride_id and not r2.planning_conflict
         -- a plan-B request's own plan-B rides are released when it takes the car
         and not exists (select 1 from ride_requests rr where rr.ride_id = r2.id
                          and (rr.request_id = p.id or rr.request_id in (select x.id from requests x where x.plan_b_parent_id = p.id)))
         and tstzrange(r2.starts_at, r2.blocked_until, '[)') && tstzrange(p.dep, p.ret, '[)'))
    -- REQ §13.114: a scheduled maintenance period on the freed car (also one added after the offer was
    -- made) is never offered, incl. the turnaround buffer before it.
    and not exists (select 1 from car_maintenance_blocks b where b.car_id = o.car_id
         and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(p.dep,
           p.ret + make_interval(mins => coalesce(public.required_turnaround_minutes(o.department_id, o.week_start), 30)), '[)'))
    -- RC1B3: the people a Sadran cancelled this ride on and kept on the waiting list are not offered its own car
    and p.id <> all(o.excluded_request_ids)
    and public.car_fits(o.car_id, p.adults, p.child_seats, p.boosters)
    and public.car_meets_needs(o.car_id, case when p.has_luggage and p.luggage_waived_at is null then 1 else 0 end, case when p.needs_tow_hitch and p.luggage_waived_at is null then 1 else 0 end)
  order by slack asc, p.submitted_at asc;
$$;

CREATE OR REPLACE FUNCTION "public"."place_waiting_request"("p_request_id" "uuid", "p_car_id" "uuid", "p_depart_at" timestamp with time zone, "p_return_at" timestamp with time zone, "p_expected_version" integer, "p_accept" "text"[] DEFAULT '{}'::"text"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  q public.requests%rowtype; v_car public.cars%rowtype; v_uid uuid := (select auth.uid());
  v_home uuid; v_origin uuid; v_car_at uuid; v_start uuid; v_next uuid; v_buffer int;
  v_prev_end timestamptz; v_next_start timestamptz; v_day date; v_phase public.week_phase;
  v_warnings jsonb := '[]'::jsonb; v_ride uuid; v_prev_transition text; v_prev_trunk text;
  v_accept text[] := coalesce(p_accept, '{}'); v_moved boolean := false;
begin
  select * into q from public.requests where id = p_request_id for update;
  select * into v_car from public.cars where id = p_car_id and department_id = q.department_id and status = 'active';
  if q.id is null or not (public.can_edit_request(q.id)
       or (v_car.type = 'temporary' and v_car.owner_id = v_uid and public.member_of(q.department_id))) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if q.version <> p_expected_version then raise exception 'stale_version' using errcode = 'P0409'; end if;
  if q.status <> 'waitlisted' or q.trip_type <> 'round_trip' or q.series_id is not null then
    return jsonb_build_object('ok', false, 'blocked', 'not_draggable');
  end if;
  if p_depart_at is null or p_return_at is null or p_return_at <= p_depart_at
     or (p_depart_at at time zone 'Asia/Jerusalem')::date <> (p_return_at at time zone 'Asia/Jerusalem')::date then
    raise exception 'invalid_ride_window' using errcode = 'P0001';
  end if;
  v_day := (p_depart_at at time zone 'Asia/Jerusalem')::date;
  select phase into v_phase from public.weeks where department_id = q.department_id and week_start = q.week_start;
  if v_phase not in ('published', 'live') or not public.is_day_public(q.department_id, q.week_start, v_day)
     or v_day <> ((coalesce(q.depart_at, q.return_at)) at time zone 'Asia/Jerusalem')::date then
    return jsonb_build_object('ok', false, 'blocked', 'not_draggable');
  end if;
  if p_depart_at < now() then return jsonb_build_object('ok', false, 'blocked', 'past'); end if;
  if exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
             where rr.request_id = q.id and r.status <> 'cancelled')
     or exists (select 1 from public.waitlist_group_members gm join public.waitlist_groups g on g.id = gm.group_id
                where gm.request_id = q.id and g.status = 'open') then
    return jsonb_build_object('ok', false, 'blocked', 'not_draggable');
  end if;

  if v_car.id is null then raise exception 'shift_car_invalid' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_car.id::text, 0));

  -- Refusals: nothing a member may take from someone else.
  -- Only the owner puts a request on their private car (REQ §13.99).
  if v_car.type = 'temporary' and v_car.owner_id is distinct from v_uid then
    return jsonb_build_object('ok', false, 'blocked', 'private_car');
  end if;
  if exists (select 1 from public.rides r where r.car_id = v_car.id and r.status <> 'cancelled' and not r.draft_hold
             and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_depart_at, p_return_at, '[)')) then
    return jsonb_build_object('ok', false, 'blocked', 'overlap');
  end if;
  if exists (select 1 from public.car_maintenance_blocks m where m.car_id = v_car.id
             and tstzrange(m.starts_at, m.ends_at, '[)') && tstzrange(p_depart_at, p_return_at, '[)')) then
    return jsonb_build_object('ok', false, 'blocked', 'maintenance');
  end if;
  if not public.car_fits(v_car.id, q.adults, q.child_seats, q.boosters) then
    return jsonb_build_object('ok', false, 'blocked', 'seats');
  end if;
  if public.car_held_by_waitlist_group(v_car.id, p_depart_at, p_return_at, q.id) then
    return jsonb_build_object('ok', false, 'blocked', 'held');
  end if;
  if exists (select 1 from public.freed_slot_offers o where o.car_id = v_car.id and o.status = 'open'
             and o.expires_at > now() and tstzrange(o.starts_at, o.ends_at, '[)') && tstzrange(p_depart_at, p_return_at, '[)')) then
    return jsonb_build_object('ok', false, 'blocked', 'offered');
  end if;
  if public.eligible_leg_driver(q.id) is null then
    return jsonb_build_object('ok', false, 'blocked', 'no_driver');
  end if;

  -- Where the ride starts: the request's place, or — once the member accepts it — where the car stands.
  select home_destination_id into v_home from public.departments where id = q.department_id;
  v_origin := case when q.origin_id is null and nullif(q.origin_text, '') is not null then null else coalesce(q.origin_id, v_home) end;
  v_car_at := coalesce(public.car_location_at(v_car.id, p_depart_at), v_home);
  v_start := coalesce(v_origin, v_home);
  -- A shared car is taken where it stands (a free-text start place never matches it); a private car goes with its owner.
  if v_car.type = 'shared' and (v_origin is null or v_car_at <> v_origin) then
    if 'location' = any(v_accept) then v_start := v_car_at; v_moved := true;
    else v_warnings := v_warnings || jsonb_build_object('code', 'location',
           'place', (select name from public.destinations where id = v_car_at));
    end if;
  end if;
  v_next := public.car_next_ride_origin(v_car.id, p_return_at);
  if v_next is not null and v_next <> v_start then
    return jsonb_build_object('ok', false, 'blocked', 'next_elsewhere');
  end if;

  -- Warnings that concern the member only.
  v_buffer := coalesce(public.required_turnaround_minutes(q.department_id, q.week_start), 30);
  select max(r.ends_at) into v_prev_end from public.rides r
    where r.car_id = v_car.id and r.status <> 'cancelled' and not r.draft_hold and r.ends_at <= p_depart_at;
  select min(r.starts_at) into v_next_start from public.rides r
    where r.car_id = v_car.id and r.status <> 'cancelled' and not r.draft_hold and r.starts_at >= p_return_at;
  if (v_prev_end is not null and v_prev_end + make_interval(mins => v_buffer) > p_depart_at)
     or (v_next_start is not null and p_return_at + make_interval(mins => v_buffer) > v_next_start) then
    if not 'turnaround' = any(v_accept) then
      v_warnings := v_warnings || jsonb_build_object('code', 'turnaround', 'minutes', v_buffer);
    end if;
  end if;
  -- REQ §13.200: the same warning (and the same accept key) covers a towing request on a car without a hitch
  if q.luggage_waived_at is null
     and not public.car_meets_needs(v_car.id, case when q.has_luggage then 1 else 0 end, case when q.needs_tow_hitch then 1 else 0 end)
     and not 'luggage' = any(v_accept) then
    v_warnings := v_warnings || jsonb_build_object('code', 'luggage', 'needs', to_jsonb(array_remove(array[
      case when q.has_luggage and not public.car_takes_luggage(v_car.id, 1) then 'large_trunk' end,
      case when q.needs_tow_hitch and not exists (select 1 from public.cars hc where hc.id = v_car.id and 'tow_hitch' = any(hc.features)) then 'tow_hitch' end], null)));
  end if;
  if jsonb_array_length(v_warnings) > 0 then
    return jsonb_build_object('ok', false, 'warnings', v_warnings);
  end if;

  -- Place it: the new hours and start place, then the same placement the Sadran's manual drop uses.
  v_prev_transition := current_setting('app.system_status_transition', true);
  v_prev_trunk := current_setting('app.small_trunk', true);
  perform set_config('app.system_status_transition', 'on', true);
  if 'luggage' = any(v_accept) then perform set_config('app.small_trunk', 'allow', true); end if;
  update public.requests set depart_at = p_depart_at, return_at = p_return_at, preferred_car_id = case when v_car.type = 'shared' then v_car.id else preferred_car_id end,
         origin_id = case when v_moved then v_start else origin_id end,
         origin_text = case when v_moved then null else origin_text end,
         changed_since_solve = true
   where id = q.id;
  v_ride := public.place_request_on_car(q.id, v_car.id, true, v_uid, null, p_depart_at, p_return_at, 'MEMBER_PLACED');
  perform set_config('app.small_trunk', coalesce(v_prev_trunk, ''), true);
  perform set_config('app.system_status_transition', coalesce(v_prev_transition, 'off'), true);

  perform public.enqueue_notification(s.profile_id, 'request_changed', q.department_id, q.week_start,
    jsonb_build_object('requestId', q.id::text), jsonb_build_object('request_id', q.id),
    format('request_changed:%s:%s', q.id, now()))
  from public.sadranim_of(q.department_id, q.week_start) as s(profile_id)
  where s.profile_id is distinct from v_uid;

  -- The owner gave their car: the requester (and a filer) learn they drive it.
  perform public.enqueue_notification(x.recipient, 'outcome_changed', q.department_id, q.week_start,
    jsonb_build_object('byName', coalesce((select full_name from public.profiles where id = v_uid), ''),
      'route', coalesce(public.request_route_label(q.id), ''), 'day', public.day_date_label(p_depart_at),
      'timeRange', public._window_text(p_depart_at, p_return_at), 'car', v_car.name),
    jsonb_build_object('variant', 'owner_car_given', 'request_id', q.id, 'ride_id', v_ride),
    format('owner_car_given:%s:%s', q.id, x.recipient))
  from (select distinct r as recipient from unnest(array[q.requester_id, q.filed_by]) r) x
  where v_car.type = 'temporary' and x.recipient is not null and x.recipient <> v_uid;

  return jsonb_build_object('ok', true, 'ride_id', v_ride, 'car_id', v_car.id);
end $$;

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
  m record; v_sadran uuid; v_variant text; v_lug int; v_tow int; v_supp text;
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

  -- REQ §13.168: a chosen member served by plan B rides with its main trip — its plan B is released first
  -- (only the outcome is told; restoring leaves the request 'submitted', which keeps it in the group).
  for v_id in select q.id from public.requests q where q.id = any(p_request_ids) and q.served_by_alternative order by q.id loop
    v_supp := coalesce(current_setting('app.suppress_notifications', true), '');
    perform set_config('app.suppress_notifications', 'on', true);
    perform public._restore_original_main(v_id);
    perform set_config('app.suppress_notifications', v_supp, true);
  end loop;

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

  select count(*) filter (where q.has_luggage and q.luggage_waived_at is null),
         count(*) filter (where q.needs_tow_hitch and q.luggage_waived_at is null)   -- REQ §13.200: one hitch, one towing request per ride
    into v_lug, v_tow from public.requests q where q.id = any(p_request_ids);

  -- REQ §13.101 (i): a car freed for this group (held offer) is the first choice.
  select c.* into v_car from public.cars c join public.freed_slot_offers fo on fo.car_id = c.id
  where fo.group_id = g.id and fo.status = 'open'
    and c.status = 'active' and c.type = 'shared'
    and public.car_fits(c.id, v_adults, v_child_seats, v_boosters)
    and public.car_meets_needs(c.id, v_lug, v_tow)
    and public.car_location_at(c.id, v_starts) = v_home
    and not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled' and not r.draft_hold
      and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_starts, v_ends + v_turnaround, '[)'))
  order by c.id limit 1;

  if v_car.id is null and v_preferred is not null then
    select c.* into v_car from public.cars c
    where c.id = v_preferred and c.department_id = g.department_id
      and c.status = 'active' and c.type = 'shared'
      and public.car_fits(c.id, v_adults, v_child_seats, v_boosters)
      and public.car_meets_needs(c.id, v_lug, v_tow)
      and public.car_location_at(c.id, v_starts) = v_home
      and not exists (select 1 from public.rides r where r.car_id = c.id and r.status <> 'cancelled' and not r.draft_hold
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_starts, v_ends + v_turnaround, '[)'));
  end if;
  if v_car.id is null then
    select c.* into v_car from public.cars c
    where c.department_id = g.department_id and c.status = 'active' and c.type = 'shared'
      and public.car_fits(c.id, v_adults, v_child_seats, v_boosters)
      and public.car_meets_needs(c.id, v_lug, v_tow)
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

  for m in select m3.request_id, m3.profile_id, m3.chosen, coalesce(q3.served_by_alternative, false) as plan_b
    from public.waitlist_group_members m3 left join public.requests q3 on q3.id = m3.request_id where m3.group_id = g.id
    order by m3.created_at, m3.id
  loop
    v_variant := case when not m.chosen and m.plan_b then 'not_chosen_plan_b'
                      when not m.chosen then (case when cardinality(p_request_ids) = 1 then 'not_chosen_one' else 'not_chosen' end)
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

CREATE OR REPLACE FUNCTION "public"."waitlist_cause"("r" "public"."requests") RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  q public.requests%rowtype;
  v_origin uuid;
  v_luggage int; v_tow int;
  v_shared int;
  v_seat_ok int;
  v_fitting int;
  v_seat_ids uuid[];
  v_fit_ids uuid[];
begin
  select * into q from public.requests where id = r.id;
  if q.id is null or q.status <> 'waitlisted' or q.status_reason is distinct from 'WAITLISTED_NO_CAR' then return null; end if;
  if not (public.request_related(q.id, (select auth.uid())) or public.can_manage_week(q.department_id, q.week_start)) then
    return null;
  end if;
  v_origin := coalesce(q.origin_id, (select d.home_destination_id from public.departments d where d.id = q.department_id));
  v_luggage := case when q.has_luggage and q.luggage_waived_at is null then 1 else 0 end;
  v_tow := case when q.needs_tow_hitch and q.luggage_waived_at is null then 1 else 0 end;

  select array_agg(c.id) filter (where public.car_fits(c.id, q.adults, q.child_seats, q.boosters)),
         array_agg(c.id) filter (where public.car_fits(c.id, q.adults, q.child_seats, q.boosters)
                                   and public.car_meets_needs(c.id, v_luggage, v_tow)),
         count(*)
  into v_seat_ids, v_fit_ids, v_shared
  from public.cars c
  where c.department_id = q.department_id and c.status = 'active' and c.type = 'shared';
  v_seat_ok := coalesce(cardinality(v_seat_ids), 0);
  v_fitting := coalesce(cardinality(v_fit_ids), 0);

  if v_fitting = 0 then return 'WAITLISTED_NO_FITTING_CAR'; end if;
  if exists (select 1 from unnest(v_fit_ids) f(id) where public._car_free_for_request(f.id, q.id, v_origin)) then
    return null;
  end if;
  if exists (select 1 from unnest(v_fit_ids) f(id) where public._car_free_for_request(f.id, q.id, null)) then
    return 'WAITLISTED_NOT_AT_ORIGIN';
  end if;
  if v_seat_ok < v_shared then
    return case when q.child_seats + q.boosters > 0 then 'WAITLISTED_CHILD_SEAT_CARS_BUSY' else 'WAITLISTED_SEAT_CARS_BUSY' end;
  end if;
  if v_fitting < v_seat_ok then return 'WAITLISTED_LARGE_TRUNK_BUSY'; end if;
  return null;
end $$;

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
      and public.car_meets_needs(p_car_id, case when q.has_luggage and q.luggage_waived_at is null then 1 else 0 end, case when q.needs_tow_hitch and q.luggage_waived_at is null then 1 else 0 end)
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
end $$;

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
      and public.car_meets_needs(c.id, case when q.has_luggage and q.luggage_waived_at is null then 1 else 0 end, case when q.needs_tow_hitch and q.luggage_waived_at is null then 1 else 0 end)
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
end $$;
