-- REQ §13.111 (a): the large-trunk problem of a merge is waivable. `_merge_check` stops treating it as a
-- refusal under `app.small_trunk = 'allow'` and reports `luggage_problem`; `merge_preview` reports a
-- luggage-only problem as ok=false, code 'luggage', waivable=true (every other verdict is computed for real);
-- the code 'luggage' also covers needs_large_trunk.

create or replace function public._merge_error_code(_err text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case _err
    when 'merge_luggage_needs_large_trunk' then 'luggage'
    when 'luggage_capacity_violation' then 'luggage'
    when 'needs_large_trunk' then 'luggage'
    when 'merge_detour_too_long' then 'detour'
    when 'merge_boards_at_end' then 'boards_at_end'
    when 'ride_request_day_mismatch' then 'window'
    when 'seat_config_violation' then 'seats'
    when 'private_car_owner_only' then 'private_car'
    when 'merge_turnaround_conflict' then 'turnaround'
    when 'merge_already_on_ride' then 'already_on_ride'
    when 'ride_conflicts_with_maintenance' then 'maintenance'
    when 'ride_not_found' then 'ride_not_found'
    else _err end
$$;

CREATE OR REPLACE FUNCTION public._merge_check(p_ride_id uuid, p_request_id uuid, p_leg ride_leg DEFAULT 'both'::ride_leg)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_ride public.rides%rowtype;
  v_lim_min int; v_lim_km numeric;
  v_leg text; v_before numeric; v_after numeric; v_refused text; v_km_before numeric; v_km_after numeric;
  v_add_min int[] := array[0, 0]; v_add_km numeric[] := array[0, 0]; v_ix int;
  v_err text; v_start timestamptz; v_end timestamptz; v_day date; v_unknown boolean;
  v_features text[]; v_luggage boolean; v_conflict boolean := false; v_side text; v_lug_problem boolean := false;
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

  return jsonb_build_object('ok', v_err is null, 'error', v_err, 'code', public._merge_error_code(v_err),
    'luggage_problem', v_lug_problem, 'turnaround_conflict', v_conflict, 'turnaround_side', v_side,
    'added_out_minutes', v_add_min[1], 'added_return_minutes', v_add_min[2],
    'added_out_km', round(v_add_km[1], 1), 'added_return_km', round(v_add_km[2], 1),
    'starts_at', v_ride.starts_at, 'new_starts_at', v_start,
    'ends_at', v_ride.ends_at, 'new_ends_at', v_end);
end;
$function$;

CREATE OR REPLACE FUNCTION public.merge_preview(p_ride_id uuid, p_request_id uuid, p_leg ride_leg DEFAULT 'both'::ride_leg)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_ride public.rides%rowtype; v_req public.requests%rowtype; v jsonb; v_err text; v_jd timestamptz; v_jr timestamptz;
  v_prev text; v_lug boolean := false;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride.id is null then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if v_req.department_id <> v_ride.department_id or v_req.week_start <> v_ride.week_start
     or not public.can_manage_week(v_ride.department_id, v_ride.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  -- REQ §13.111 (a): checked "as if allowed" so every other verdict (detour, seats, turnaround...) is real; a large-trunk
  -- problem alone comes back as a *waivable* refusal (code 'luggage', waivable true) the Sadran may accept.
  v_prev := coalesce(current_setting('app.small_trunk', true), '');
  perform set_config('app.small_trunk', 'allow', true);
  v := public._merge_check(p_ride_id, p_request_id, p_leg);
  perform set_config('app.small_trunk', v_prev, true);
  v_err := v ->> 'error';
  v_lug := coalesce((v ->> 'luggage_problem')::boolean, false);
  select jt.dep, jt.ret into v_jd, v_jr from public._joiner_times(p_ride_id, p_request_id, p_leg) jt;
  if v_err is null and coalesce((v ->> 'turnaround_conflict')::boolean, false) then v_err := 'merge_turnaround_conflict'; end if;
  if v_err is null then
    begin
      perform public.assert_private_car_owner_only(v_ride.car_id, (select auth.uid()), v_req.requester_id);
    exception when others then
      if sqlerrm = 'private_car_owner_only' then v_err := sqlerrm; end if;
    end;
  end if;
  if v_err is null and v_lug and v_prev <> 'allow' then v_err := 'merge_luggage_needs_large_trunk'; end if;
  -- seats / luggage are part of _merge_check (R7B3): one verdict for preview, create, send and apply.
  return v || jsonb_build_object('ok', v_err is null, 'error', v_err, 'code', public._merge_error_code(v_err),
    'waivable', coalesce(v_lug and v_err = 'merge_luggage_needs_large_trunk', false),
    'joiner_depart_at', v_jd, 'joiner_return_at', v_jr,
    'joiner_old_depart_at', case when p_leg in ('out', 'both') then v_req.depart_at end,
    'joiner_old_return_at', case when p_leg in ('return', 'both') then v_req.return_at end);
end $function$;
