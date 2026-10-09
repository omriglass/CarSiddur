-- R12B4/R12B5 (REQ §13.119): _merge_check refuses a leg the ride does not run / a time hours away from the ride, and reports
-- `person_overlaps` (warning only). Full definition from schema-current.sql with the three additions.
CREATE OR REPLACE FUNCTION "public"."_merge_check"("p_ride_id" "uuid", "p_request_id" "uuid", "p_leg" "public"."ride_leg" DEFAULT 'both'::"public"."ride_leg") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ride public.rides%rowtype;
  v_lim_min int; v_lim_km numeric;
  v_leg text; v_before numeric; v_after numeric; v_refused text; v_km_before numeric; v_km_after numeric;
  v_add_min int[] := array[0, 0]; v_add_km numeric[] := array[0, 0]; v_ix int;
  v_err text; v_start timestamptz; v_end timestamptz; v_day date; v_unknown boolean;
  v_features text[]; v_luggage boolean; v_guest public.requests%rowtype; v_swap boolean; v_boarding timestamptz; v_anchor timestamptz; v_tol interval; v_overlaps jsonb := '[]'::jsonb; v_conflict boolean := false; v_side text; v_lug_problem boolean := false;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride.id is null then return jsonb_build_object('ok', false, 'error', 'ride_not_found', 'code', 'ride_not_found'); end if;
  select coalesce(s.detour_limit_minutes, 20), coalesce(s.detour_limit_km, 15) into v_lim_min, v_lim_km
  from public.department_settings s where s.department_id = v_ride.department_id;
  v_lim_min := coalesce(v_lim_min, 20); v_lim_km := coalesce(v_lim_km, 15);

  -- REQ §13.102 R2B13: the request is already on this ride for those legs - the same merge is never offered twice.
  if exists(select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.request_id = p_request_id
            and ((p_leg in ('out', 'both') and rr.covers_out) or (p_leg in ('return', 'both') and rr.covers_return))) then
    v_err := 'merge_already_on_ride';
  end if;

  -- REQ item 21 (2026-10-07): large luggage is a yes/no match - a large-luggage (ציוד רב) request
  -- rides only on a `large_trunk` car, and any number of them may share that car (no count cap).
  select coalesce(c.features, '{}') into v_features from public.cars c where c.id = v_ride.car_id;
  -- REQ §13.111 (a): a waived request does not need it; under `app.small_trunk = 'allow'` (a caller that passed
  -- allow_small_trunk, or merge_preview asking "is luggage the only problem?") the problem is only reported.
  v_luggage := public.request_needs_large_trunk(p_request_id);
  if v_luggage and not ('large_trunk' = any (coalesce(v_features, '{}'))) then
    if coalesce(current_setting('app.small_trunk', true), '') = 'allow' then
      v_lug_problem := true;
    else
      v_err := coalesce(v_err, 'merge_luggage_needs_large_trunk');
    end if;
  end if;

  foreach v_leg in array array['out', 'return'] loop
    -- every leg is priced: a reversed one-way guest (R6B5) adds driving on the host's return leg although it joins as 'out'.
    v_ix := case when v_leg = 'out' then 1 else 2 end;

    select round(extract(epoch from (max(r.eta) - min(r.eta))) / 60) into v_before
    from public._ride_route_with(p_ride_id, null, 'both') r where r.leg = v_leg::public.ride_leg;
    select round(extract(epoch from (max(r.eta) - min(r.eta))) / 60), max(r.refused) into v_after, v_refused
    from public._ride_route_with(p_ride_id, p_request_id, p_leg) r where r.leg = v_leg::public.ride_leg;
    if v_refused is not null then v_err := coalesce(v_err, v_refused); end if;

    select coalesce(sum(coalesce((select pt.distance_km from public.place_travel(x.place_id, x.next_id) pt), 0)), 0) into v_km_before
    from (select r.place_id, lead(r.place_id) over (order by r.position) as next_id
          from public._ride_route_with(p_ride_id, null, 'both') r where r.leg = v_leg::public.ride_leg) x
    where x.place_id is not null and x.next_id is not null;
    select coalesce(sum(coalesce((select pt.distance_km from public.place_travel(x.place_id, x.next_id) pt), 0)), 0) into v_km_after
    from (select r.place_id, lead(r.place_id) over (order by r.position) as next_id
          from public._ride_route_with(p_ride_id, p_request_id, p_leg) r where r.leg = v_leg::public.ride_leg) x
    where x.place_id is not null and x.next_id is not null;

    -- REQ §13.95: a free-text place on the merged route has no known travel time, so the added
    -- driving is unknown — the Sadran's judgement decides (no detour-limit refusal, no automatic
    -- window change; a payload window still applies on apply). Boarding-before-the-end still holds.
    select exists(select 1 from public._ride_route_with(p_ride_id, p_request_id, p_leg) r
                  where r.leg = v_leg::public.ride_leg and r.place_id is null) into v_unknown;
    if v_unknown then
      v_add_min[v_ix] := 0; v_add_km[v_ix] := 0;
    else
      v_add_min[v_ix] := greatest(coalesce(v_after, 0) - coalesce(v_before, 0), 0)::int;
      v_add_km[v_ix] := greatest(coalesce(v_km_after, 0) - coalesce(v_km_before, 0), 0);
      if v_err is null and (v_add_min[v_ix] > v_lim_min or v_add_km[v_ix] > v_lim_km) then v_err := 'merge_detour_too_long'; end if;
    end if;
  end loop;

  -- REQ §13.112 (c): a ride that serves a window request ("N hours between A and B") keeps its length, so a merge that adds
  -- driving (and so grows the block) is refused; a merge that adds none still goes through.
  if v_err is null and (v_add_min[1] > 0 or v_add_min[2] > 0) and exists(
       select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
       where rr.ride_id = p_ride_id and q.duration_locked) then
    v_err := 'merge_window_locked';
  end if;

  -- R12B5 (REQ §13.119): the guest must actually be ON the merged route for the leg asked: a ride without a
  -- return leg cannot take a "return" join, and a guest who boards at (or after) the route's end is refused. A guest
  -- whose own time is hours away from the ride's estimated time at the boarding point is a "window" refusal
  -- (tolerance: the guest's own flexibility, at least 2 hours); a free-text boarding place has no estimate.
  select * into v_guest from public.requests where id = p_request_id;
  if v_err is null and v_guest.id is not null
     and exists(select 1 from public.ride_requests rb where rb.ride_id = p_ride_id and rb.request_id <> p_request_id) then
    v_swap := public._merge_guest_swapped(p_ride_id, p_request_id);
    -- the route legs the guest rides: a reversed one-way rides the host's RETURN leg (see _ride_route_with)
    foreach v_leg in array case when v_swap then array['return']
        else array_remove(array[case when p_leg in ('out', 'both') then 'out' end, case when p_leg in ('return', 'both') then 'return' end], null) end loop
      if not exists(select 1 from public._ride_route_with(p_ride_id, p_request_id, p_leg) r where r.leg = v_leg::public.ride_leg) then
        v_err := 'merge_boards_at_end';
        exit;
      end if;
      select min(r.eta) into v_boarding from public._ride_route_with(p_ride_id, p_request_id, p_leg) r
      where r.leg = v_leg::public.ride_leg
        and r.place_id is not null and r.place_id = (case when v_leg = 'out' or v_swap then v_guest.origin_id else v_guest.destination_id end);
      continue when v_boarding is null;
      if v_leg = 'out' or v_swap then
        continue when v_guest.depart_at is null;
        v_tol := greatest(interval '2 hours', v_guest.flex_depart_early, v_guest.flex_depart_late);
        v_anchor := v_guest.depart_at;
      else
        continue when v_guest.return_at is null;
        v_tol := greatest(interval '2 hours', v_guest.flex_return_early, v_guest.flex_return_late);
        v_anchor := v_guest.return_at;
      end if;
      if abs(extract(epoch from (v_boarding - v_anchor))) > extract(epoch from v_tol) then v_err := 'ride_request_day_mismatch'; exit; end if;
    end loop;
  end if;

  -- Window: leave earlier by the added driving out, end later by the added driving back (quarter-hour grid).
  v_day := (v_ride.starts_at at time zone 'Asia/Jerusalem')::date;
  v_start := v_ride.starts_at - make_interval(mins => (ceil(v_add_min[1] / 15.0) * 15)::int);
  v_end := v_ride.ends_at;
  if (v_end at time zone 'Asia/Jerusalem')::time = time '23:59' and v_add_min[2] > 0 then v_end := v_end + interval '1 minute'; end if;
  v_end := v_end + make_interval(mins => (ceil(v_add_min[2] / 15.0) * 15)::int);
  if v_err is null and (((v_start at time zone 'Asia/Jerusalem')::date <> v_day)
      or (((v_end - interval '1 minute') at time zone 'Asia/Jerusalem')::date <> v_day)) then
    v_err := 'ride_request_day_mismatch';
  end if;
  if (v_end at time zone 'Asia/Jerusalem')::time = time '00:00' then
    v_end := (((v_day) + time '23:59') at time zone 'Asia/Jerusalem');
  end if;

  -- REQ item 108 (2026-10-07): a merge that grows the window may not push the ride over a car
  -- maintenance block - the same rule as rides_before_write (the ride's own turnaround counts after
  -- the end, none before; admins are exempt). A window that does not grow was already accepted.
  if v_err is null and not (v_start >= v_ride.starts_at and v_end <= v_ride.ends_at) and not public.is_admin()
     and exists(select 1 from public.car_maintenance_blocks b where b.car_id = v_ride.car_id
       and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_start, v_end + (v_ride.blocked_until - v_ride.ends_at), '[)')) then
    v_err := 'ride_conflicts_with_maintenance';
  end if;

  v_side := case when v_err is null then public._merge_window_conflict_side(p_ride_id, v_start, v_end) end;
  v_conflict := v_side is not null;

  -- R7B3/R6B1: the same rolled-back seat probe `merge_preview` always ran, so every caller (create, send, apply,
  -- preview) refuses what the apply would refuse. The apply counts the ride's driver once (assert_ride_seats_fit).
  if v_err is null then
    begin
      delete from public.ride_requests where request_id = p_request_id and ride_id <> p_ride_id;
      insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
      values (p_ride_id, p_request_id, 'passenger', p_leg, 'passenger');
      perform public.assert_ride_seats_fit(p_ride_id);
      raise exception 'merge_probe_ok' using errcode = 'P0001';
    exception when others then
      if sqlerrm in ('seat_config_violation', 'luggage_capacity_violation') then v_err := sqlerrm;
      elsif sqlerrm = 'needs_large_trunk' then v_err := 'merge_luggage_needs_large_trunk'; end if;
    end;
  end if;

  -- R12B4 (REQ §13.119): warning only - the guest's person (requester) is already driving or riding another live
  -- ride that overlaps the merged ride (the guest's own current booking is released by the merge, so it is not counted).
  select coalesce(jsonb_agg(jsonb_build_object('ride_id', x.id, 'starts_at', x.starts_at, 'ends_at', x.ends_at,
           'role', x.role) order by x.starts_at), '[]'::jsonb) into v_overlaps
  from (
    select r.id, r.starts_at, r.ends_at,
           case when r.driver_id = v_guest.requester_id then 'driver' else 'passenger' end as role
    from public.rides r
    where v_guest.id is not null and r.department_id = v_ride.department_id and r.id <> p_ride_id and r.status <> 'cancelled'
      and (r.driver_id = v_guest.requester_id
           or exists (select 1 from public.ride_requests rr join public.requests rq on rq.id = rr.request_id
                      where rr.ride_id = r.id and rq.requester_id = v_guest.requester_id and rq.id <> p_request_id)
           or exists (select 1 from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id = v_guest.requester_id))
      and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(v_start, v_end, '[)')
  ) x;

  return jsonb_build_object('ok', v_err is null, 'error', v_err, 'code', public._merge_error_code(v_err),
    'person_overlaps', v_overlaps, 'luggage_problem', v_lug_problem, 'turnaround_conflict', v_conflict, 'turnaround_side', v_side,
    'added_out_minutes', v_add_min[1], 'added_return_minutes', v_add_min[2],
    'added_out_km', round(v_add_km[1], 1), 'added_return_km', round(v_add_km[2], 1),
    'starts_at', v_ride.starts_at, 'new_starts_at', v_start,
    'ends_at', v_ride.ends_at, 'new_ends_at', v_end);
end;
$$;

ALTER FUNCTION "public"."_merge_check"("p_ride_id" "uuid", "p_request_id" "uuid", "p_leg" "public"."ride_leg") OWNER TO "postgres";
