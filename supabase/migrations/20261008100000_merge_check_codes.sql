-- REQ §13.102 e (R2M3): every merge refusal carries a machine reason code, and the board preview also probes seats,
-- private cars and the car's turnaround. Codes: seats, detour, boards_at_end, luggage, luggage_count, private_car,
-- window, turnaround, already_on_ride, ride_not_found. REQ §13.102 R2B2: `_merge_window_conflict` lets create/apply
-- refuse a merge whose automatic window growth would break the car's turnaround instead of silently waiving it.

create or replace function public._merge_error_code(_err text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case _err
    when 'merge_luggage_needs_large_trunk' then 'luggage'
    when 'merge_luggage_too_many' then 'luggage_count'
    when 'luggage_capacity_violation' then 'luggage'
    when 'merge_detour_too_long' then 'detour'
    when 'merge_boards_at_end' then 'boards_at_end'
    when 'ride_request_day_mismatch' then 'window'
    when 'seat_config_violation' then 'seats'
    when 'private_car_owner_only' then 'private_car'
    when 'merge_turnaround_conflict' then 'turnaround'
    when 'merge_already_on_ride' then 'already_on_ride'
    when 'ride_not_found' then 'ride_not_found'
    else _err end
$$;

-- True when moving the ride's window to [_new_start, _new_end) (grown on either side) leaves less than the car's
-- turnaround to a neighbouring ride of the same car.
create or replace function public._merge_window_conflict(_ride_id uuid, _new_start timestamptz, _new_end timestamptz)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare h public.rides%rowtype;
begin
  select * into h from public.rides where id = _ride_id;
  if h.id is null then return false; end if;
  if _new_start >= h.starts_at and _new_end <= h.ends_at then return false; end if;
  return exists(select 1 from public.rides x
    where x.car_id = h.car_id and x.id <> h.id and x.status <> 'cancelled'
      and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(_new_start, _new_end + (h.blocked_until - h.ends_at), '[)'));
end $$;

create or replace function public._merge_check(p_ride_id uuid, p_request_id uuid, p_leg ride_leg DEFAULT 'both'::ride_leg) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_ride public.rides%rowtype;
  v_lim_min int; v_lim_km numeric;
  v_leg text; v_before numeric; v_after numeric; v_refused text; v_km_before numeric; v_km_after numeric;
  v_add_min int[] := array[0, 0]; v_add_km numeric[] := array[0, 0]; v_ix int;
  v_err text; v_start timestamptz; v_end timestamptz; v_day date; v_unknown boolean;
  v_features text[]; v_luggage boolean; v_others int; v_conflict boolean := false;
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

  -- REQ §13.101 a / item 21: a large-luggage (ציוד רב) request rides only on a `large_trunk` car,
  -- at most two such requests per car.
  select coalesce(c.features, '{}') into v_features from public.cars c where c.id = v_ride.car_id;
  select coalesce(q.has_luggage, false) into v_luggage from public.requests q where q.id = p_request_id;
  if v_luggage then
    if not ('large_trunk' = any (coalesce(v_features, '{}'))) then
      v_err := coalesce(v_err, 'merge_luggage_needs_large_trunk');
    else
      select count(distinct q.id) into v_others
      from public.ride_requests rr join public.requests q on q.id = rr.request_id
      where rr.ride_id = p_ride_id and q.has_luggage and q.id <> p_request_id;
      if v_others >= 2 then v_err := coalesce(v_err, 'merge_luggage_too_many'); end if;
    end if;
  end if;

  foreach v_leg in array array['out', 'return'] loop
    continue when p_leg <> 'both' and p_leg::text <> v_leg;
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

  v_conflict := v_err is null and public._merge_window_conflict(p_ride_id, v_start, v_end);

  return jsonb_build_object('ok', v_err is null, 'error', v_err, 'code', public._merge_error_code(v_err),
    'turnaround_conflict', v_conflict,
    'added_out_minutes', v_add_min[1], 'added_return_minutes', v_add_min[2],
    'added_out_km', round(v_add_km[1], 1), 'added_return_km', round(v_add_km[2], 1),
    'starts_at', v_ride.starts_at, 'new_starts_at', v_start,
    'ends_at', v_ride.ends_at, 'new_ends_at', v_end);
end;
$$;



-- Board preview (Sadran only). Volatile on purpose: seats are probed by a real insert that is always rolled back.
-- Returns `_merge_check`'s fields plus `code` (machine reason, see header) and `error`; `ok` is false on any refusal.
create or replace function public.merge_preview(p_ride_id uuid, p_request_id uuid, p_leg public.ride_leg default 'both')
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_ride public.rides%rowtype; v_req public.requests%rowtype; v jsonb; v_err text;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride.id is null then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if v_req.department_id <> v_ride.department_id or v_req.week_start <> v_ride.week_start
     or not public.can_manage_week(v_ride.department_id, v_ride.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  v := public._merge_check(p_ride_id, p_request_id, p_leg);
  v_err := v ->> 'error';
  if v_err is null and coalesce((v ->> 'turnaround_conflict')::boolean, false) then v_err := 'merge_turnaround_conflict'; end if;
  if v_err is null then
    begin
      perform public.assert_private_car_owner_only(v_ride.car_id, (select auth.uid()), v_req.requester_id);
    exception when others then
      if sqlerrm = 'private_car_owner_only' then v_err := sqlerrm; end if;
    end;
  end if;
  if v_err is null then
    begin
      delete from public.ride_requests where request_id = p_request_id and ride_id <> p_ride_id;
      insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
      values (p_ride_id, p_request_id, 'passenger', p_leg, 'passenger');
      perform public.assert_ride_seats_fit(p_ride_id);
      raise exception 'merge_probe_ok' using errcode = 'P0001';
    exception when others then
      if sqlerrm in ('seat_config_violation', 'luggage_capacity_violation') then v_err := sqlerrm; end if;
    end;
  end if;
  return v || jsonb_build_object('ok', v_err is null, 'error', v_err, 'code', public._merge_error_code(v_err));
end $$;

revoke all on function public.merge_preview(uuid, uuid, public.ride_leg) from public;
grant execute on function public.merge_preview(uuid, uuid, public.ride_leg) to authenticated;
