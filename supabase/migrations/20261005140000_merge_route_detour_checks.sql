-- REQ §13.95 H1 (SQL side): a merge never boards at/after the base ride's final destination and stays
-- within the department's detour limit; the ride leaves earlier (return ends later) by the added driving.
--   * _route_add_place(): `board` is inserted strictly before the final destination (an existing route
--     place matches only before it; a boarding place equal to the final destination yields o_idx = -1),
--     `alight` at or before it. Nothing is ever appended after the final destination any more.
--   * _ride_route_with(ride, extra request, extra leg): the route builder (the former _ride_route body)
--     that can also include a not-yet-merged request; an extra `refused` column carries the refusal
--     code of a leg ('merge_boards_at_end') on every row of that leg. _ride_route() wraps it unchanged.
--   * _merge_check(ride, request, leg) -> jsonb: ok/error, per-leg added minutes and km, and the
--     resulting window (start - ceil15(added out), end + ceil15(added return)); errors
--     merge_boards_at_end, merge_detour_too_long, ride_request_day_mismatch.
--   * merge_preview(ride, request, leg): browser-facing wrapper (can_manage_week) for the popup.
create or replace function public._route_add_place(
  p_route jsonb, p_place_id uuid, p_place_text text, p_request uuid, p_kind text, p_after int,
  out o_idx int, out o_route jsonb)
returns record
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  n int := jsonb_array_length(p_route);
  i int; k int; best_k int; best_cost int; cost int;
  prev_id uuid; next_id uuid;
  elem jsonb := jsonb_build_object('place_id', p_place_id, 'place_text', p_place_text,
    'request_id', p_request, 'kind', p_kind);
begin
  if p_place_id is not null then
    for i in greatest(p_after, 0) + 1 .. (case when p_kind = 'board' then n - 1 else n end) loop
      if nullif(p_route -> (i - 1) ->> 'place_id', '')::uuid = p_place_id then
        o_idx := i; o_route := p_route; return;
      end if;
    end loop;
    -- REQ §13.95: boarding where the base ride ends is no ride at all.
    if p_kind = 'board' and greatest(p_after, 0) < n
       and nullif(p_route -> (n - 1) ->> 'place_id', '')::uuid = p_place_id then
      o_idx := -1; o_route := p_route; return;
    end if;
  end if;
  for k in greatest(p_after + 1, 2) .. n loop
    prev_id := nullif(p_route -> (k - 2) ->> 'place_id', '')::uuid;
    next_id := nullif(p_route -> (k - 1) ->> 'place_id', '')::uuid;
    cost := public._route_hop_minutes(prev_id, p_place_id) + public._route_hop_minutes(p_place_id, next_id)
          - public._route_hop_minutes(prev_id, next_id);
    if best_cost is null or cost < best_cost then best_cost := cost; best_k := k; end if;
  end loop;
  if best_k is null then o_idx := -1; o_route := p_route; return; end if;
  o_route := jsonb_insert(p_route, array[(best_k - 1)::text], elem);
  o_idx := best_k;
end;
$$;

create or replace function public._ride_route_with(p_ride_id uuid, p_extra_request uuid default null, p_extra_leg public.ride_leg default 'both')
returns table(leg public.ride_leg, "position" int, place_id uuid, place_text text, request_id uuid, kind text, eta timestamptz, refused text)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_ride public.rides%rowtype;
  v_base uuid; v_out boolean; v_ret boolean;
  v_stop_min int;
  v_leg text;
  v_route jsonb; g record;
  v_board int; v_tmp record; v_refused text;
  v_n int; i int; v_t timestamptz; v_e jsonb; v_prev_id uuid; v_cur_id uuid;
  v_b_id uuid; v_b_text text; v_a_id uuid; v_a_text text; v_covers boolean;
begin
  select * into v_ride from public.rides r where r.id = p_ride_id;
  if v_ride.id is null then return; end if;
  select coalesce(ds.stop_minutes, 5) into v_stop_min from public.department_settings ds where ds.department_id = v_ride.department_id;
  v_stop_min := coalesce(v_stop_min, 5);

  select rr.request_id into v_base from public.ride_requests rr where rr.ride_id = p_ride_id
  order by (rr.role = 'driver') desc, rr.created_at, rr.request_id limit 1;

  if v_base is null then
    leg := 'out'; "position" := 0; place_id := v_ride.origin_id; place_text := null; request_id := null; kind := 'origin'; eta := v_ride.starts_at; refused := null;
    return next;
    "position" := 1; place_id := v_ride.destination_id; kind := 'destination'; eta := v_ride.ends_at;
    return next;
    return;
  end if;

  select coalesce(bool_or(rr.covers_out), false), coalesce(bool_or(rr.covers_return), false) into v_out, v_ret
  from public.ride_requests rr where rr.ride_id = p_ride_id and rr.request_id = v_base;

  foreach v_leg in array array['out', 'return'] loop
    if (v_leg = 'out' and not v_out) or (v_leg = 'return' and not v_ret) then continue; end if;

    select coalesce(jsonb_agg(jsonb_build_object('place_id', p.place_id, 'place_text', p.place_text,
        'request_id', v_base,
        'kind', case when p."position" = 0 then 'origin'
                     when p."position" = (select max(p2."position") from public.request_leg_route_points(v_base, v_leg::public.ride_leg) p2) then 'destination'
                     else 'stop' end) order by p."position"), '[]'::jsonb)
      into v_route
    from public.request_leg_route_points(v_base, v_leg::public.ride_leg) p;
    if jsonb_array_length(v_route) < 2 then continue; end if;

    v_refused := null;
    for g in
      select q.id, q.origin_id, q.origin_text, q.destination_id, q.destination_text,
             bool_or(rr.covers_out) as c_out, bool_or(rr.covers_return) as c_ret, min(rr.created_at) as first_at
      from public.ride_requests rr join public.requests q on q.id = rr.request_id
      where rr.ride_id = p_ride_id and rr.request_id <> v_base
      group by q.id, q.origin_id, q.origin_text, q.destination_id, q.destination_text
      union all
      select q.id, q.origin_id, q.origin_text, q.destination_id, q.destination_text,
             (p_extra_leg in ('out', 'both')), (p_extra_leg in ('return', 'both')), 'infinity'::timestamptz
      from public.requests q
      where q.id = p_extra_request and q.id <> v_base
        and not exists (select 1 from public.ride_requests rx where rx.ride_id = p_ride_id and rx.request_id = q.id)
      order by first_at, id
    loop
      v_covers := case when v_leg = 'out' then g.c_out else g.c_ret end;
      if not v_covers then continue; end if;
      if v_leg = 'out' then
        v_b_id := g.origin_id; v_b_text := g.origin_text; v_a_id := g.destination_id; v_a_text := g.destination_text;
      else
        v_b_id := g.destination_id; v_b_text := g.destination_text; v_a_id := g.origin_id; v_a_text := g.origin_text;
      end if;
      select * into v_tmp from public._route_add_place(v_route, v_b_id, v_b_text, g.id, 'board', 0);
      if v_tmp.o_idx < 0 then
        v_refused := coalesce(v_refused, 'merge_boards_at_end');
        continue; -- this guest is left off the route; the refusal is reported on the leg
      end if;
      v_route := v_tmp.o_route; v_board := v_tmp.o_idx;
      select * into v_tmp from public._route_add_place(v_route, v_a_id, v_a_text, g.id, 'alight', v_board);
      if v_tmp.o_idx >= 0 then v_route := v_tmp.o_route; end if;
    end loop;

    v_n := jsonb_array_length(v_route);
    if v_leg = 'out' then
      v_t := v_ride.starts_at;
      for i in 1 .. v_n loop
        v_e := v_route -> (i - 1);
        v_cur_id := nullif(v_e ->> 'place_id', '')::uuid;
        if i > 1 then
          v_t := v_t + make_interval(mins => (case when i > 2 then v_stop_min else 0 end)
            + public._route_hop_minutes(v_prev_id, v_cur_id));
        end if;
        leg := 'out'; "position" := i - 1; place_id := v_cur_id; place_text := nullif(v_e ->> 'place_text', '');
        request_id := nullif(v_e ->> 'request_id', '')::uuid; kind := v_e ->> 'kind'; eta := v_t; refused := v_refused;
        return next;
        v_prev_id := v_cur_id;
      end loop;
    else
      v_t := v_ride.ends_at;
      for i in reverse v_n .. 1 loop
        v_e := v_route -> (i - 1);
        v_cur_id := nullif(v_e ->> 'place_id', '')::uuid;
        if i < v_n then
          v_t := v_t - make_interval(mins => (case when i + 1 < v_n then v_stop_min else 0 end)
            + public._route_hop_minutes(v_cur_id, v_prev_id));
        end if;
        leg := 'return'; "position" := i - 1; place_id := v_cur_id; place_text := nullif(v_e ->> 'place_text', '');
        request_id := nullif(v_e ->> 'request_id', '')::uuid; kind := v_e ->> 'kind'; eta := v_t; refused := v_refused;
        return next;
        v_prev_id := v_cur_id;
      end loop;
    end if;
  end loop;
end;
$$;

create or replace function public._ride_route(p_ride_id uuid)
returns table(leg public.ride_leg, "position" int, place_id uuid, place_text text, request_id uuid, kind text, eta timestamptz)
language sql stable security definer set search_path = public, pg_temp
as $$
  select r.leg, r."position", r.place_id, r.place_text, r.request_id, r.kind, r.eta
  from public._ride_route_with(p_ride_id, null, 'both') r;
$$;

create or replace function public._merge_check(p_ride_id uuid, p_request_id uuid, p_leg public.ride_leg default 'both')
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_ride public.rides%rowtype;
  v_lim_min int; v_lim_km numeric;
  v_leg text; v_before numeric; v_after numeric; v_refused text; v_km_before numeric; v_km_after numeric;
  v_add_min int[] := array[0, 0]; v_add_km numeric[] := array[0, 0]; v_ix int;
  v_err text; v_start timestamptz; v_end timestamptz; v_day date;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride.id is null then return jsonb_build_object('ok', false, 'error', 'ride_not_found'); end if;
  select coalesce(s.detour_limit_minutes, 20), coalesce(s.detour_limit_km, 15) into v_lim_min, v_lim_km
  from public.department_settings s where s.department_id = v_ride.department_id;
  v_lim_min := coalesce(v_lim_min, 20); v_lim_km := coalesce(v_lim_km, 15);

  foreach v_leg in array array['out', 'return'] loop
    continue when p_leg <> 'both' and p_leg::text <> v_leg;
    v_ix := case when v_leg = 'out' then 1 else 2 end;

    select round(extract(epoch from (max(r.eta) - min(r.eta))) / 60) into v_before
    from public._ride_route_with(p_ride_id, null, 'both') r where r.leg = v_leg::public.ride_leg;
    select round(extract(epoch from (max(r.eta) - min(r.eta))) / 60), max(r.refused) into v_after, v_refused
    from public._ride_route_with(p_ride_id, p_request_id, p_leg) r where r.leg = v_leg::public.ride_leg;
    if v_refused is not null then v_err := coalesce(v_err, v_refused); end if;

    select coalesce(sum(coalesce((select pt.distance_km from public.place_travel(x.place_id, x.next_id) pt), 0)), 0) into v_km_before
    from (select r.place_id, lead(r.place_id) over (order by r."position") as next_id
          from public._ride_route_with(p_ride_id, null, 'both') r where r.leg = v_leg::public.ride_leg) x
    where x.place_id is not null and x.next_id is not null;
    select coalesce(sum(coalesce((select pt.distance_km from public.place_travel(x.place_id, x.next_id) pt), 0)), 0) into v_km_after
    from (select r.place_id, lead(r.place_id) over (order by r."position") as next_id
          from public._ride_route_with(p_ride_id, p_request_id, p_leg) r where r.leg = v_leg::public.ride_leg) x
    where x.place_id is not null and x.next_id is not null;

    v_add_min[v_ix] := greatest(coalesce(v_after, 0) - coalesce(v_before, 0), 0)::int;
    v_add_km[v_ix] := greatest(coalesce(v_km_after, 0) - coalesce(v_km_before, 0), 0);
    if v_err is null and (v_add_min[v_ix] > v_lim_min or v_add_km[v_ix] > v_lim_km) then v_err := 'merge_detour_too_long'; end if;
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

  return jsonb_build_object('ok', v_err is null, 'error', v_err,
    'added_out_minutes', v_add_min[1], 'added_return_minutes', v_add_min[2],
    'added_out_km', round(v_add_km[1], 1), 'added_return_km', round(v_add_km[2], 1),
    'starts_at', v_ride.starts_at, 'new_starts_at', v_start,
    'ends_at', v_ride.ends_at, 'new_ends_at', v_end);
end;
$$;

create or replace function public.merge_preview(p_ride_id uuid, p_request_id uuid, p_leg public.ride_leg default 'both')
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_ride public.rides%rowtype; v_req public.requests%rowtype;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride.id is null then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if v_req.department_id <> v_ride.department_id or v_req.week_start <> v_ride.week_start
     or not public.can_manage_week(v_ride.department_id, v_ride.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  return public._merge_check(p_ride_id, p_request_id, p_leg);
end;
$$;

revoke all on function public._ride_route_with(uuid, uuid, public.ride_leg) from public;
revoke all on function public._merge_check(uuid, uuid, public.ride_leg) from public;
revoke all on function public.merge_preview(uuid, uuid, public.ride_leg) from public;
grant execute on function public.merge_preview(uuid, uuid, public.ride_leg) to authenticated;
