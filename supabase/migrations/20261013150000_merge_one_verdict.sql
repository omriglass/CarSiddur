-- QA run 6/7 merges (group B), REQ item 108 e / 109 g:
--  * R7B3/R6B1: one merge verdict. `_merge_check` now also probes seats and luggage (the rolled-back insert
--    `merge_preview` used to do alone), so create_proposal, send_proposal, apply_proposal and merge_preview all
--    refuse the same merges; send_proposal also refuses a window that now eats a turnaround.
--  * R6B3: `_merge_check` names the side of a turnaround clash (`turnaround_side` previous | next).
--  * R6B10: `_joiner_times` returns the guest's return as the request defines it (arrival at their origin, the
--    alight time), not the time they leave the destination.
--  * R6B5: a one-way request that is exactly the reverse of a round-trip host (boards where the host's out leg ends,
--    alights at the host's return end) rides the host's return leg (`_merge_guest_swapped`, `_ride_route_with`).
-- Full create-or-replace of every changed function (current definitions: supabase/schema-current.sql).

create or replace function public._merge_guest_swapped(p_ride_id uuid, p_request_id uuid) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  q public.requests%rowtype; v_base uuid; v_out boolean; v_ret boolean; v_out_end uuid; v_ret_end uuid;
begin
  select * into q from public.requests where id = p_request_id;
  if q.id is null or q.depart_at is null or q.return_at is not null or q.origin_id is null or q.destination_id is null then return false; end if;
  select rr.request_id into v_base from public.ride_requests rr where rr.ride_id = p_ride_id
  order by (rr.role = 'driver') desc, rr.created_at, rr.request_id limit 1;
  if v_base is null or v_base = p_request_id then return false; end if;
  select coalesce(bool_or(rr.covers_out), false), coalesce(bool_or(rr.covers_return), false) into v_out, v_ret
  from public.ride_requests rr where rr.ride_id = p_ride_id and rr.request_id = v_base;
  if not (v_out and v_ret) then return false; end if;
  select p.place_id into v_out_end from public.request_leg_route_points(v_base, 'out') p order by p."position" desc limit 1;
  select p.place_id into v_ret_end from public.request_leg_route_points(v_base, 'return') p order by p."position" desc limit 1;
  return v_out_end is not null and v_ret_end is not null and q.origin_id = v_out_end and q.destination_id = v_ret_end;
end $$;

revoke all on function public._merge_guest_swapped(uuid, uuid) from public;
grant execute on function public._merge_guest_swapped(uuid, uuid) to service_role;

create or replace function public._merge_window_conflict_side(_ride_id uuid, _new_start timestamptz, _new_end timestamptz) returns text
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare h public.rides%rowtype; v_x public.rides%rowtype;
begin
  select * into h from public.rides where id = _ride_id;
  if h.id is null then return null; end if;
  if _new_start >= h.starts_at and _new_end <= h.ends_at then return null; end if;
  select x.* into v_x from public.rides x
    where x.car_id = h.car_id and x.id <> h.id and x.status <> 'cancelled'
      and tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(_new_start, _new_end + (h.blocked_until - h.ends_at), '[)')
    order by x.starts_at, x.id limit 1;
  if v_x.id is null then return null; end if;
  return case when v_x.starts_at < h.starts_at then 'previous' else 'next' end;
end $$;

revoke all on function public._merge_window_conflict_side(uuid, timestamptz, timestamptz) from public;
grant execute on function public._merge_window_conflict_side(uuid, timestamptz, timestamptz) to service_role;


CREATE OR REPLACE FUNCTION "public"."_ride_route_with"("p_ride_id" "uuid", "p_extra_request" "uuid" DEFAULT NULL::"uuid", "p_extra_leg" "public"."ride_leg" DEFAULT 'both'::"public"."ride_leg") RETURNS TABLE("leg" "public"."ride_leg", "position" integer, "place_id" "uuid", "place_text" "text", "request_id" "uuid", "kind" "text", "eta" timestamp with time zone, "refused" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
#variable_conflict use_column
declare
  v_ride public.rides%rowtype;
  v_base uuid; v_out boolean; v_ret boolean;
  v_stop_min int;
  v_leg text;
  v_route jsonb; g record;
  v_board int; v_tmp record; v_refused text;
  v_n int; i int; v_t timestamptz; v_e jsonb; v_prev_id uuid; v_cur_id uuid;
  v_b_id uuid; v_b_text text; v_a_id uuid; v_a_text text; v_covers boolean; v_swap boolean; v_fwd boolean;
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
      -- R6B5: a one-way request that is exactly the reverse of a round-trip host rides the host's RETURN leg
      -- (boards at the out leg's end, alights at the return leg's end), in its own direction.
      v_swap := public._merge_guest_swapped(p_ride_id, g.id);
      if v_swap and v_leg = 'out' then continue; end if;
      v_covers := case when v_swap then (v_leg = 'return' and (g.c_out or g.c_ret))
                       when v_leg = 'out' then g.c_out else g.c_ret end;
      if not v_covers then continue; end if;
      v_fwd := v_leg = 'out' or v_swap;
      if v_fwd then
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


create or replace function public._joiner_times(_ride_id uuid, _request_id uuid, _leg public.ride_leg, out dep timestamptz, out ret timestamptz) returns record
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  q public.requests%rowtype; v_ride public.rides%rowtype; v_mc jsonb; v_sw boolean;
  v_out_shift interval := interval '0'; v_ret_shift interval := interval '0';
begin
  select * into q from public.requests where id = _request_id;
  select * into v_ride from public.rides where id = _ride_id;
  v_mc := public._merge_check(_ride_id, _request_id, _leg);
  if v_mc ->> 'new_starts_at' is not null and v_ride.id is not null then
    v_out_shift := (v_mc ->> 'new_starts_at')::timestamptz - v_ride.starts_at;
    v_ret_shift := (v_mc ->> 'new_ends_at')::timestamptz - v_ride.ends_at;
  end if;
  v_sw := public._merge_guest_swapped(_ride_id, _request_id);
  if v_sw then
    -- R6B5: a reversed one-way guest leaves at its boarding stop on the host's return leg.
    select coalesce(max(case when x.leg = 'return' and x.kind = 'board' and x.request_id = _request_id then x.eta end),
                    min(case when x.leg = 'return' and x.place_id = q.origin_id then x.eta end)) + v_ret_shift
      into dep from public._ride_route_with(_ride_id, _request_id, _leg) x;
    ret := null;
  else
    select
      coalesce(max(case when x.leg = 'out' and x.kind = 'board' and x.request_id = _request_id then x.eta end),
               max(case when x.leg = 'out' and x."position" = 0 then x.eta end)) + v_out_shift,
      -- R6B10: the request's return is the ARRIVAL at its origin (the alight time), not the time it leaves the destination.
      coalesce(max(case when x.leg = 'return' and x.kind = 'alight' and x.request_id = _request_id then x.eta end),
               max(case when x.leg = 'return' and x.place_id is not null and x.place_id = q.origin_id and x."position" > 0 then x.eta end),
               max(case when x.leg = 'return' and x.kind = 'board' and x.request_id = _request_id then x.eta end),
               max(case when x.leg = 'return' and x."position" = 0 then x.eta end)) + v_ret_shift
    into dep, ret
    from public._ride_route_with(_ride_id, _request_id, _leg) x;
    ret := public._round5(coalesce(ret, case when _leg in ('return', 'both') then q.return_at end));
  end if;
  dep := public._round5(coalesce(dep, case when _leg in ('out', 'both') then q.depart_at end));
  if _leg = 'return' and not v_sw then dep := null; elsif _leg = 'out' and not v_sw then ret := null; end if;
end $$;


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
  v_features text[]; v_luggage boolean; v_conflict boolean := false; v_side text;
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
  select coalesce(q.has_luggage, false) into v_luggage from public.requests q where q.id = p_request_id;
  if v_luggage and not ('large_trunk' = any (coalesce(v_features, '{}'))) then
    v_err := coalesce(v_err, 'merge_luggage_needs_large_trunk');
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
      if sqlerrm in ('seat_config_violation', 'luggage_capacity_violation') then v_err := sqlerrm; end if;
    end;
  end if;

  return jsonb_build_object('ok', v_err is null, 'error', v_err, 'code', public._merge_error_code(v_err),
    'turnaround_conflict', v_conflict, 'turnaround_side', v_side,
    'added_out_minutes', v_add_min[1], 'added_return_minutes', v_add_min[2],
    'added_out_km', round(v_add_km[1], 1), 'added_return_km', round(v_add_km[2], 1),
    'starts_at', v_ride.starts_at, 'new_starts_at', v_start,
    'ends_at', v_ride.ends_at, 'new_ends_at', v_end);
end;
$$;


CREATE OR REPLACE FUNCTION "public"."merge_preview"("p_ride_id" "uuid", "p_request_id" "uuid", "p_leg" "public"."ride_leg" DEFAULT 'both'::"public"."ride_leg") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_ride public.rides%rowtype; v_req public.requests%rowtype; v jsonb; v_err text; v_jd timestamptz; v_jr timestamptz;
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
  select jt.dep, jt.ret into v_jd, v_jr from public._joiner_times(p_ride_id, p_request_id, p_leg) jt;
  if v_err is null and coalesce((v ->> 'turnaround_conflict')::boolean, false) then v_err := 'merge_turnaround_conflict'; end if;
  if v_err is null then
    begin
      perform public.assert_private_car_owner_only(v_ride.car_id, (select auth.uid()), v_req.requester_id);
    exception when others then
      if sqlerrm = 'private_car_owner_only' then v_err := sqlerrm; end if;
    end;
  end if;
  -- seats / luggage are part of _merge_check (R7B3): one verdict for preview, create, send and apply.
  return v || jsonb_build_object('ok', v_err is null, 'error', v_err, 'code', public._merge_error_code(v_err),
    'joiner_depart_at', v_jd, 'joiner_return_at', v_jr,
    'joiner_old_depart_at', case when p_leg in ('out', 'both') then v_req.depart_at end,
    'joiner_old_return_at', case when p_leg in ('return', 'both') then v_req.return_at end);
end $$;


ALTER FUNCTION "public"."merge_preview"("p_ride_id" "uuid", "p_request_id" "uuid", "p_leg" "public"."ride_leg") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."merge_request_fingerprint"("p_request_id" "uuid") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select md5((to_jsonb(q)-array['status','status_reason','version','updated_at','changed_since_solve'])::text) from public.requests q where id=p_request_id;
$$;


CREATE OR REPLACE FUNCTION "public"."send_proposal"("p_proposal_id" "uuid", "p_sent_via" "public"."notification_channel"[] DEFAULT '{}'::"public"."notification_channel"[], "p_replace_proposal_id" "uuid" DEFAULT NULL::"uuid", "p_replace_expected_version" integer DEFAULT NULL::integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_prop public.proposals%rowtype;
  v_previous public.proposals%rowtype;
  v_request public.requests%rowtype;
  v_request_id uuid;
  v_token text;
  v_proposal_token text;
  v_party_tokens jsonb:='{}';
  v_party record;
  v_reader jsonb; v_check jsonb; v_h record; v_leg_txt text; v_ext boolean := false;
begin
  select request_id into v_request_id from public.proposals where id=p_proposal_id;
  if v_request_id is null then raise exception 'proposal_not_found'; end if;
  -- This order is also used by answer_proposal: request, proposals, then parties.
  select * into v_request from public.requests where id=v_request_id for update;
  perform 1 from public.proposals where request_id=v_request_id order by id for update;
  select * into v_prop from public.proposals where id=p_proposal_id;
  if not public.can_manage_week(v_prop.department_id,v_prop.week_start) and (
    v_prop.created_via<>'ask_to_join' or not public.member_of(v_prop.department_id) or v_request.requester_id<>(select auth.uid())) then
    raise exception 'not_authorized';
  end if;
  if v_prop.status<>'draft' then raise exception 'proposal_not_draft'; end if;
  -- Owner decision (20260910098000): the day may have gone public between draft and send
  -- (create_proposal() guards at creation time, but a draft sitting unsent is never touched
  -- by expire_proposals(), which only expires status='sent' rows) — re-check at send time.
  -- Same ask to join exemption as create_proposal().
  if v_prop.created_via <> 'ask_to_join' and v_prop.type not in ('shift','merge')
     and public.is_day_public(v_prop.department_id, v_prop.week_start,
       (coalesce(v_request.depart_at, v_request.return_at) at time zone 'Asia/Jerusalem')::date)
  then
    raise exception 'proposal_day_public' using errcode = 'P0001';
  end if;
  if v_prop.type='merge' and exists(select 1 from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) l
       left join public.rides r on r.id=(l->>'ride_id')::uuid where r.id is null or r.status='cancelled') then
    raise exception 'ride_not_found' using errcode='P0001';
  end if;
  -- REQ §13.102 R2B13: a merge that no longer holds (the member is already on the ride for those legs, a seat or
  -- detour limit now fails) is refused at send time, so the same merge is never sent twice.
  if v_prop.type='merge' then
    for v_h in select distinct (l->>'ride_id')::uuid as ride_id from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) l loop
      select case when count(distinct coalesce(l->>'leg','both'))>1 or bool_or(coalesce(l->>'leg','both')='both') then 'both'
                  else max(coalesce(l->>'leg','both')) end into v_leg_txt
      from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) l
      where (l->>'ride_id')::uuid=v_h.ride_id and coalesce(l->>'role','passenger')<>'driver';
      if v_leg_txt is not null then
        v_check:=public._merge_check(v_h.ride_id,v_request.id,v_leg_txt::public.ride_leg);
        if not (v_check->>'ok')::boolean then raise exception '%',v_check->>'error' using errcode='P0001'; end if;
        -- R7B3: the same turnaround rule as create_proposal / apply_proposal (only an explicit consented window may be tight).
        if coalesce((v_check->>'turnaround_conflict')::boolean,false)
           and not (coalesce((v_prop.payload->>'window_explicit')::boolean,false) and coalesce((v_prop.payload->>'allow_tight_turnaround')::boolean,false)) then
          raise exception 'merge_turnaround_conflict' using errcode='P0001';
        end if;
      end if;
    end loop;
  end if;
  select * into v_previous from public.proposals where request_id=v_request_id and status='sent';
  -- REQ §13.103 R3B11: a Sadran merge draft that extends the sent merge (the other leg of a split merge) replaces it
  -- itself: no replacement arguments needed (a stale board version is no conflict), the old one is withdrawn.
  v_ext := v_prop.type='merge' and v_prop.created_via='sadran' and v_previous.id is not null
    and v_prop.payload->>'extends_proposal_id' = v_previous.id::text;
  if v_ext then
    if v_previous.answered_at is not null or exists(select 1 from public.proposal_parties where proposal_id=v_previous.id and response<>'pending') then
      raise exception 'proposal_replacement_answered';
    end if;
  elsif p_replace_proposal_id is null then
    if v_previous.id is not null then raise exception 'proposal_already_sent'; end if;
    if p_replace_expected_version is not null then perform public.raise_stale_version(); end if;
  else
    -- Replacing another person's offer is a coordinator action, even for ask-to-join drafts.
    if not public.can_manage_week(v_prop.department_id,v_prop.week_start) then raise exception 'not_authorized'; end if;
    if v_previous.id is distinct from p_replace_proposal_id or v_previous.version is distinct from p_replace_expected_version
      or v_request.status<>'proposed' then
      perform public.raise_stale_version();
    end if;
    if v_previous.answered_at is not null or exists(select 1 from public.proposal_parties where proposal_id=v_previous.id and response<>'pending') then
      raise exception 'proposal_replacement_answered';
    end if;
  end if;
  perform set_config('app.audit_reason','send_proposal',true);
  perform set_config('app.system_status_transition','on',true);
  if v_previous.id is not null then
    -- Expiring restores the pre-offer request state. Carry it into the replacement,
    -- whose draft may have been created while the request was already proposed.
    update public.proposals set status=case when v_ext then 'withdrawn' else 'expired' end::public.proposal_status where id=v_previous.id;
    v_request.status:=v_previous.previous_status;
  end if;
  v_proposal_token:=public.generate_token();
  update public.proposals set previous_status=v_request.status,
    token_hash=encode(digest(v_proposal_token,'sha256'),'hex'),status='sent',sent_at=now(),sent_via=p_sent_via
    where id=p_proposal_id;
  perform set_config('app.system_status_transition','off',true);
  for v_party in select id,profile_id from public.proposal_parties where proposal_id=p_proposal_id order by id for update loop
    v_token:=public.generate_token();
    update public.proposal_parties set token_hash=encode(digest(v_token,'sha256'),'hex') where id=v_party.id;
    v_party_tokens:=v_party_tokens||jsonb_build_object(v_party.profile_id::text,v_token);
  end loop;
  for v_party in select profile_id from public.proposal_parties where proposal_id=p_proposal_id loop
    -- REQ §13.101 b: one text per reader (variant + old -> new variables), never the whole WhatsApp text.
    v_reader:=public.proposal_reader_vars(p_proposal_id,v_party.profile_id);
    perform public.enqueue_notification(v_party.profile_id,'proposal_received',v_prop.department_id,v_prop.week_start,
      coalesce(v_reader->'vars','{}'::jsonb),
      jsonb_build_object('proposal_id',p_proposal_id,'url','/p/'||(v_party_tokens->>v_party.profile_id::text),'variant',v_reader->>'variant'),
      format('proposal_received:%s:%s',p_proposal_id,v_party.profile_id));
  end loop;
  return jsonb_build_object('proposal_token',v_proposal_token,'party_tokens',v_party_tokens);
end $$;


ALTER FUNCTION "public"."send_proposal"("p_proposal_id" "uuid", "p_sent_via" "public"."notification_channel"[], "p_replace_proposal_id" "uuid", "p_replace_expected_version" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_freed_slot_opt_out"("p_request_id" "uuid", "p_opt_out" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_req record;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if v_req.requester_id <> (select auth.uid()) and not public.can_manage_week(v_req.department_id, v_req.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'set_freed_slot_opt_out', true);
  update public.requests set freed_slot_opt_out = p_opt_out where id = p_request_id;
end;
$$;

