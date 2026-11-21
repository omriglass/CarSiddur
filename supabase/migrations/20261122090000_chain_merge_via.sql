-- CM1 phase 3 (REQ item 260 c, owner 2026-11-21 answer 2): people on only one of two chained trips. The long (base)
-- trip's people who are not on the short trip either ride the whole chained ride, or the ride passes the shared start
-- place again for them: `before_via` picks them up there after the short trip's far end (home -> school -> home ->
-- Binyamina), `after_via` drops them there before it (Binyamina -> home -> school -> home). The merge check returns
-- both variants (route, their time) as `chain.one_trip`; the choice travels as `app.chain_via` (member_merge_ride's
-- p_chain_via) or the applied proposal's payload `chain_via`. Seats and the stops view give those people the part
-- of the ride they are on.

CREATE OR REPLACE FUNCTION "public"."_ride_route_with"("p_ride_id" "uuid", "p_extra_request" "uuid", "p_extra_leg" "public"."ride_leg", "p_chain" "jsonb") RETURNS TABLE("leg" "public"."ride_leg", "position" integer, "place_id" "uuid", "place_text" "text", "request_id" "uuid", "kind" "text", "eta" timestamp with time zone, "refused" "text")
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
  v_chain_req uuid; v_chain_side text; v_p jsonb;
begin
  select * into v_ride from public.rides r where r.id = p_ride_id;
  if v_ride.id is null then return; end if;
  select coalesce(ds.stop_minutes, 5) into v_stop_min from public.department_settings ds where ds.department_id = v_ride.department_id;
  v_stop_min := coalesce(v_stop_min, 5);

  -- CM1 phase 2: a chained ride - the base trip's route with the chained (short) trip joined before or after it
  if p_chain is not null and jsonb_typeof(p_chain) = 'object' then
    v_chain_req := (p_chain ->> 'request_id')::uuid; v_chain_side := p_chain ->> 'side';
    v_base := (p_chain ->> 'base_request_id')::uuid;
    v_ride.starts_at := coalesce((p_chain ->> 'starts_at')::timestamptz, v_ride.starts_at);
    v_ride.ends_at := coalesce((p_chain ->> 'ends_at')::timestamptz, v_ride.ends_at);
  else
    select rr.request_id, rr.chain into v_chain_req, v_chain_side from public.ride_requests rr
     where rr.ride_id = p_ride_id and rr.chain is not null order by rr.request_id limit 1;
    select rr.request_id into v_base from public.ride_requests rr
     where rr.ride_id = p_ride_id and rr.request_id is distinct from v_chain_req
     order by (rr.role = 'driver') desc, rr.created_at, rr.request_id limit 1;
    if v_base is null then
      v_chain_req := null; v_chain_side := null;
      select rr.request_id into v_base from public.ride_requests rr where rr.ride_id = p_ride_id
      order by (rr.role = 'driver') desc, rr.created_at, rr.request_id limit 1;
    end if;
  end if;

  if v_base is null then
    leg := 'out'; "position" := 0; place_id := v_ride.origin_id; place_text := null; request_id := null; kind := 'origin'; eta := v_ride.starts_at; refused := null;
    return next;
    "position" := 1; place_id := v_ride.destination_id; kind := 'destination'; eta := v_ride.ends_at;
    return next;
    return;
  end if;

  select coalesce(bool_or(rr.covers_out), false), coalesce(bool_or(rr.covers_return), false) into v_out, v_ret
  from public.ride_requests rr where rr.ride_id = p_ride_id and rr.request_id = v_base;
  if v_chain_req is not null then v_out := true; v_ret := true; end if;   -- a chain's base rides both ways

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

    -- before: out = [start] ++ the chained trip's way there (its stops, its far end) ++ the base's way there;
    -- after: return = the base's way back without its end ++ the chained trip's way there and back after its start ++ [end].
    -- The shared start / end place stays the base's (both trips start from the same place).
    -- CM1 phase 3: before_via also drives the chained trip's way back (to the start again, a stop of the chained trip)
    -- before the base's way there; after_via drives from the base's far end to the start first (a stop), then the
    -- chained trip's way there and back.
    if v_chain_req is not null and v_leg = 'out' and v_chain_side like 'before%' then
      select coalesce(jsonb_agg(y.e order by y.part, y.pos), '[]'::jsonb) into v_p from (
        select 1 as part, p."position" as pos,
               jsonb_build_object('place_id', p.place_id, 'place_text', p.place_text, 'request_id', v_chain_req,
                 'kind', case when p."position" = x.m then 'alight' else 'stop' end) as e
          from public.request_leg_route_points(v_chain_req, 'out') p
          cross join (select max(p2."position") as m from public.request_leg_route_points(v_chain_req, 'out') p2) x
         where p."position" > 0
        union all
        select 2, p."position",
               jsonb_build_object('place_id', p.place_id, 'place_text', p.place_text, 'request_id', v_chain_req, 'kind', 'stop')
          from public.request_leg_route_points(v_chain_req, 'return') p
         where v_chain_side = 'before_via' and p."position" > 0) y;
      v_route := jsonb_build_array(v_route -> 0) || v_p || (v_route - 0);
    elsif v_chain_req is not null and v_leg = 'return' and v_chain_side like 'after%' then
      select coalesce(jsonb_agg(y.e order by y.part, y.pos), '[]'::jsonb) into v_p from (
        select 1 as part, p."position" as pos,
               jsonb_build_object('place_id', p.place_id, 'place_text', p.place_text, 'request_id', v_chain_req,
                 'kind', case when p."position" = x.m then 'board' else 'stop' end) as e
          from public.request_leg_route_points(v_chain_req, 'out') p
          cross join (select max(p2."position") as m from public.request_leg_route_points(v_chain_req, 'out') p2) x
         where p."position" > case when v_chain_side = 'after_via' then -1 else 0 end
        union all
        select 2, p."position",
               jsonb_build_object('place_id', p.place_id, 'place_text', p.place_text, 'request_id', v_chain_req, 'kind', 'stop')
          from public.request_leg_route_points(v_chain_req, 'return') p
          cross join (select max(p2."position") as m from public.request_leg_route_points(v_chain_req, 'return') p2) x
         where p."position" > 0 and p."position" < x.m) y;
      v_route := (v_route - (-1)) || v_p || jsonb_build_array(v_route -> (-1));
    end if;

    v_refused := null;
    for g in
      select q.id, q.origin_id, q.origin_text, q.destination_id, q.destination_text,
             bool_or(rr.covers_out) as c_out, bool_or(rr.covers_return) as c_ret, min(rr.created_at) as first_at
      from public.ride_requests rr join public.requests q on q.id = rr.request_id
      where rr.ride_id = p_ride_id and rr.request_id <> v_base and rr.request_id is distinct from v_chain_req
      group by q.id, q.origin_id, q.origin_text, q.destination_id, q.destination_text
      union all
      select q.id, q.origin_id, q.origin_text, q.destination_id, q.destination_text,
             (p_extra_leg in ('out', 'both')), (p_extra_leg in ('return', 'both')), 'infinity'::timestamptz
      from public.requests q
      where q.id = p_extra_request and q.id <> v_base and q.id is distinct from v_chain_req
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


CREATE OR REPLACE FUNCTION "public"."_ride_leg_riders"("p_ride_id" "uuid", "p_leg" "public"."ride_leg", "p_with_passengers" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_route jsonb;
  v_n int;
  v_base uuid;
  v_base_idx int[];
  v_riders jsonb := '[]'::jsonb;
  q record; s record; p record;
  v_b int; v_a int; v_from int; v_to int;
  v_rows jsonb;
  v_less_a int; v_less_c int; v_less_b int;
  v_key text;
  v_bid uuid; v_btext text; v_aid uuid; v_atext text;
  v_dup_a int; v_dup_c int;
  v_chain_req uuid; v_chain_side text; v_via int; v_shared text[]; v_req_shared boolean; v_split jsonb; v_split_a int; v_split_c int;
  v_rest int; v_vb int; v_va int; v_pk text;
begin
  select coalesce(jsonb_agg(jsonb_build_object('place_id', r.place_id, 'place_text', r.place_text, 'request_id', r.request_id, 'kind', r.kind)
           order by r."position"), '[]'::jsonb)
    into v_route from public._ride_route(p_ride_id) r where r.leg = p_leg;
  v_n := jsonb_array_length(v_route);
  if v_n < 2 then return jsonb_build_object('points', greatest(v_n, 2), 'riders', '[]'::jsonb); end if;

  select rr.request_id into v_base from public.ride_requests rr where rr.ride_id = p_ride_id
   order by (rr.role = 'driver') desc, rr.created_at, rr.request_id limit 1;
  -- route index of each of the base request's own points (origin, its stops, destination), in order
  select array_agg(e.i - 1 order by e.i) into v_base_idx
    from jsonb_array_elements(v_route) with ordinality e(v, i)
   where (e.v ->> 'request_id')::uuid = v_base and e.v ->> 'kind' in ('origin', 'stop', 'destination');
  -- CM1 phase 3: a chain that passes the start place again on this leg - the base trip's people who are not on the
  -- chained trip get on there (before_via, the way there) / off there (after_via, the way back)
  select rr.request_id, rr.chain into v_chain_req, v_chain_side from public.ride_requests rr
   where rr.ride_id = p_ride_id and rr.chain like '%\_via' order by rr.request_id limit 1;
  if v_chain_req is not null and ((p_leg = 'out' and v_chain_side = 'before_via') or (p_leg = 'return' and v_chain_side = 'after_via')) then
    select case when v_chain_side = 'before_via' then max(e.i - 1) else min(e.i - 1) end into v_via
      from jsonb_array_elements(v_route) with ordinality e(v, i) where (e.v ->> 'request_id')::uuid = v_chain_req;
    select public._request_person_keys(v_chain_req)
           || coalesce((select array['p:' || r.driver_id] from public.rides r where r.id = p_ride_id and r.driver_id is not null), '{}'::text[])
      into v_shared;
    if v_via is null or v_via <= 0 or v_via >= v_n - 1 then v_via := null; end if;
  end if;

  for q in
    select x.id, x.requester_id, x.adults, x.child_seats, x.boosters, x.origin_id, x.origin_text, x.destination_id, x.destination_text,
           coalesce(cardinality(x.guest_passenger_names), 0) as gn,
           (select count(*) from public.request_companions rc where rc.request_id = x.id)::int as cn
      from public.requests x
     where x.id in (select rr.request_id from public.ride_requests rr where rr.ride_id = p_ride_id
                     and public._rr_on_leg(p_leg::text, rr.covers_out, rr.covers_return, rr.chain))   -- CM1: a chained trip, its own leg only
     order by x.id
  loop
    -- this request's span on the ride route
    if q.id = v_base then
      v_from := 0; v_to := v_n - 1;
    else
      select min(e.i - 1) into v_b from jsonb_array_elements(v_route) with ordinality e(v, i)
       where e.i < v_n and (((e.v ->> 'request_id')::uuid = q.id and e.v ->> 'kind' = 'board')
          or (e.v ->> 'place_id')::uuid = case when p_leg = 'out' then q.origin_id else q.destination_id end);
      select min(e.i - 1) into v_a from jsonb_array_elements(v_route) with ordinality e(v, i)
       where e.i - 1 > coalesce(v_b, 0) and (((e.v ->> 'request_id')::uuid = q.id and e.v ->> 'kind' = 'alight')
          or (e.v ->> 'place_id')::uuid = case when p_leg = 'out' then q.destination_id else q.origin_id end);
      if v_b is null or v_a is null then v_from := 0; v_to := v_n - 1; else v_from := v_b; v_to := v_a; end if;
    end if;

    -- the rider rows that still describe someone on this request
    select coalesce(jsonb_agg(to_jsonb(r) order by r.rider_key), '[]'::jsonb) into v_rows
      from public.request_rider_stops r
     where r.request_id = q.id and r.leg = p_leg
       and ((r.rider_key like 'companion:%' and exists (select 1 from public.request_companions rc
               where rc.request_id = q.id and rc.profile_id = substr(r.rider_key, 11)::uuid))
         or (r.rider_key like 'child:%' and exists (select 1 from public.request_children ch
               where ch.request_id = q.id and ch.child_id = substr(r.rider_key, 7)::uuid))
         or (r.rider_key like 'guest:%' and substr(r.rider_key, 7)::int <= greatest(q.adults - 1 - q.cn, q.gn, 0)));

    select least(coalesce(sum(case when x ->> 'seat_kind' = 'adult' then 1 else 0 end), 0)::int, q.adults),
           least(coalesce(sum(case when x ->> 'seat_kind' = 'child_seat' then 1 else 0 end), 0)::int, q.child_seats),
           least(coalesce(sum(case when x ->> 'seat_kind' = 'booster' then 1 else 0 end), 0)::int, q.boosters)
      into v_less_a, v_less_c, v_less_b
      from jsonb_array_elements(v_rows) x;
    -- CM1 phase 2: a chained trip's people who are on the base trip too are counted there (one person, one seat)
    if exists (select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.request_id = q.id and rr.chain is not null) then
      select count(*) filter (where k like 'p:%'), count(*) filter (where k like 'c:%') into v_dup_a, v_dup_c
        from unnest(public._request_person_keys(q.id)) k where k = any (public._request_person_keys(v_base));
      v_less_a := least(v_less_a + v_dup_a, q.adults); v_less_c := least(v_less_c + v_dup_c, q.child_seats);
    end if;
    -- CM1 phase 3: the base trip on a leg passing the start again - each of its people rides their own part: the
    -- requester's part for the request's row, a row of its own for whoever is on the other part
    v_split := '[]'::jsonb; v_split_a := 0; v_split_c := 0;
    if q.id = v_base and v_via is not null then
      v_req_shared := ('p:' || q.requester_id) = any (v_shared);
      if v_chain_side = 'before_via' then v_vb := v_via; v_va := v_n - 1; else v_vb := 0; v_va := v_via; end if;
      if not v_req_shared then v_from := v_vb; v_to := v_va; end if;
      select coalesce(jsonb_agg(jsonb_build_object('adults', case when y.kind = 'comp' then 1 else 0 end,
               'childSeats', case when y.kind = 'child' then 1 else 0 end, 'boosters', 0,
               'board', case when v_req_shared then v_vb else 0 end, 'alight', case when v_req_shared then v_va else v_n - 1 end,
               'key', y.kind || ':' || q.id || ':' || y.pid) order by y.kind, y.pid), '[]'::jsonb),
             count(*) filter (where y.kind = 'comp')::int, count(*) filter (where y.kind = 'child')::int
        into v_split, v_split_a, v_split_c
        from (select 'comp' as kind, rc.profile_id::text as pid, 'p:' || rc.profile_id as pk, 'companion:' || rc.profile_id as rk
                from public.request_companions rc where rc.request_id = q.id
              union all
              select 'child', ch.child_id::text, 'c:' || ch.child_id, 'child:' || ch.child_id
                from public.request_children ch where ch.request_id = q.id) y
       where (y.pk = any (v_shared)) <> v_req_shared
         and not exists (select 1 from jsonb_array_elements(v_rows) r where r ->> 'rider_key' = y.rk);
      v_split_a := least(v_split_a, greatest(q.adults - v_less_a, 0));
      v_split_c := least(v_split_c, greatest(q.child_seats - v_less_c, 0));
      if v_req_shared then
        -- the unnamed adults are on this trip only
        v_rest := greatest(q.adults - v_less_a - v_split_a - 1
                    - (select count(*) from public.request_companions rc where rc.request_id = q.id
                        and ('p:' || rc.profile_id) = any (v_shared)
                        and not exists (select 1 from jsonb_array_elements(v_rows) r where r ->> 'rider_key' = 'companion:' || rc.profile_id))::int, 0);
        if v_rest > 0 then
          v_split := v_split || jsonb_build_array(jsonb_build_object('adults', v_rest, 'childSeats', 0, 'boosters', 0,
            'board', v_vb, 'alight', v_va, 'key', 'rest:' || q.id));
          v_split_a := v_split_a + v_rest;
        end if;
      end if;
    end if;
    v_riders := v_riders || jsonb_build_array(jsonb_build_object('adults', q.adults - v_less_a - v_split_a, 'childSeats', q.child_seats - v_less_c - v_split_c,
      'boosters', q.boosters - v_less_b, 'board', v_from, 'alight', v_to, 'key', 'req:' || q.id)) || v_split;

    for s in select x as r from jsonb_array_elements(v_rows) x loop
      v_key := case split_part(s.r ->> 'rider_key', ':', 1)
                 when 'companion' then 'comp:' || q.id || ':' || split_part(s.r ->> 'rider_key', ':', 2)
                 when 'child' then 'child:' || q.id || ':' || split_part(s.r ->> 'rider_key', ':', 2)
                 else 'guest:' || q.id || ':' || split_part(s.r ->> 'rider_key', ':', 2) end;
      if not (s.r ->> 'rides')::boolean then
        -- not riding this leg: no seat, the tag says so
        v_riders := v_riders || jsonb_build_array(jsonb_build_object('adults', 0, 'childSeats', 0, 'boosters', 0, 'key', v_key, 'absent', true));
        continue;
      end if;
      v_b := v_from; v_a := v_to;
      if q.id = v_base and v_base_idx is not null then
        -- positions on the base request's own route of this leg, mapped to the ride route
        v_b := null; v_a := null;
        select min(pt."position") into v_b from public.request_leg_route_points(q.id, p_leg) pt
         where pt."position" < cardinality(v_base_idx) - 1
           and ((s.r ->> 'board_place_id' is not null and pt.place_id = (s.r ->> 'board_place_id')::uuid)
             or (s.r ->> 'board_place_text' is not null and lower(pt.place_text) = lower(s.r ->> 'board_place_text')));
        select min(pt."position") into v_a from public.request_leg_route_points(q.id, p_leg) pt
         where pt."position" > coalesce(v_b, 0)
           and ((s.r ->> 'alight_place_id' is not null and pt.place_id = (s.r ->> 'alight_place_id')::uuid)
             or (s.r ->> 'alight_place_text' is not null and lower(pt.place_text) = lower(s.r ->> 'alight_place_text')));
        v_b := coalesce(v_base_idx[coalesce(v_b, 0) + 1], 0);
        v_a := coalesce(v_base_idx[coalesce(v_a, cardinality(v_base_idx) - 1) + 1], v_n - 1);
        -- CM1 phase 3: someone on this trip only gets on (off) where the chain passes the start again
        if v_via is not null then
          v_pk := case split_part(s.r ->> 'rider_key', ':', 1) when 'companion' then 'p:' || split_part(s.r ->> 'rider_key', ':', 2)
                    when 'child' then 'c:' || split_part(s.r ->> 'rider_key', ':', 2) end;
          if v_pk is null or not (v_pk = any (v_shared)) then
            if v_chain_side = 'before_via' then v_b := greatest(v_b, v_via); else v_a := least(v_a, v_via); end if;
          end if;
        end if;
      end if;
      v_riders := v_riders || jsonb_build_array(jsonb_build_object(
        'adults', case when s.r ->> 'seat_kind' = 'adult' then 1 else 0 end,
        'childSeats', case when s.r ->> 'seat_kind' = 'child_seat' then 1 else 0 end,
        'boosters', case when s.r ->> 'seat_kind' = 'booster' then 1 else 0 end,
        'board', v_b, 'alight', v_a, 'key', v_key));
    end loop;
  end loop;

  if p_with_passengers then
    for p in select rp.* from public.ride_passengers rp
              where rp.ride_id = p_ride_id and (rp.leg = 'both' or rp.leg = p_leg) order by rp.id loop
      -- a row riding both ways: the way back's own places
      if p.leg = 'both' and p_leg = 'return' then
        v_bid := p.return_board_place_id; v_btext := p.return_board_place_text; v_aid := p.return_alight_place_id; v_atext := p.return_alight_place_text;
      else
        v_bid := p.board_place_id; v_btext := p.board_place_text; v_aid := p.alight_place_id; v_atext := p.alight_place_text;
      end if;
      select min(e.i - 1) into v_b from jsonb_array_elements(v_route) with ordinality e(v, i)
       where e.i < v_n and ((v_bid is not null and (e.v ->> 'place_id')::uuid = v_bid)
          or (v_btext is not null and lower(e.v ->> 'place_text') = lower(v_btext)));
      select min(e.i - 1) into v_a from jsonb_array_elements(v_route) with ordinality e(v, i)
       where e.i - 1 > coalesce(v_b, 0) and ((v_aid is not null and (e.v ->> 'place_id')::uuid = v_aid)
          or (v_atext is not null and lower(e.v ->> 'place_text') = lower(v_atext)));
      v_riders := v_riders || jsonb_build_array(jsonb_build_object(
        'adults', case when p.seat_kind = 'adult' then 1 else 0 end,
        'childSeats', case when p.seat_kind = 'child_seat' then 1 else 0 end,
        'boosters', case when p.seat_kind = 'booster' then 1 else 0 end,
        'board', v_b, 'alight', v_a, 'key', 'added:' || p.id));
    end loop;
  end if;

  return jsonb_build_object('points', v_n, 'riders', v_riders);
end;
$$;

-- ====================================================================================================
-- One variant of a chained route, for the merge popup: its places (named), its driving minutes, and the time the base
-- trip's people who are not on the chained trip get on (before*) / off (after*).
create or replace function public._chain_variant(p_route jsonb, p_side text, p_chained uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'side', p_side,
    'minutes', (select coalesce(round(sum(x.m)), 0)::int from (
        select extract(epoch from (max(r.eta) - min(r.eta))) / 60 as m
          from jsonb_to_recordset(p_route) as r(leg public.ride_leg, eta timestamptz) group by r.leg) x),
    'route', (select coalesce(jsonb_agg(jsonb_build_object('leg', r.leg, 'place_id', r.place_id,
                 'name', coalesce(d.name, r.place_text), 'request_id', r.request_id, 'kind', r.kind, 'eta', r.eta)
                 order by r.leg, r."position"), '[]'::jsonb)
        from jsonb_to_recordset(p_route) as r(leg public.ride_leg, "position" integer, place_id uuid, place_text text, request_id uuid, kind text, eta timestamptz)
        left join public.destinations d on d.id = r.place_id),
    'at', case p_side
        when 'before' then (select min(r.eta) from jsonb_to_recordset(p_route) as r(leg public.ride_leg, eta timestamptz) where r.leg = 'out')
        when 'after' then (select max(r.eta) from jsonb_to_recordset(p_route) as r(leg public.ride_leg, eta timestamptz) where r.leg = 'return')
        when 'before_via' then (select r.eta from jsonb_to_recordset(p_route) as r(leg public.ride_leg, "position" integer, request_id uuid, eta timestamptz)
                                 where r.leg = 'out' and r.request_id = p_chained order by r."position" desc limit 1)
        else (select r.eta from jsonb_to_recordset(p_route) as r(leg public.ride_leg, "position" integer, request_id uuid, eta timestamptz)
               where r.leg = 'return' and r.request_id = p_chained order by r."position" limit 1) end);
$$;
revoke all on function public._chain_variant(jsonb, text, uuid) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION "public"."_merge_check"("p_ride_id" "uuid", "p_request_id" "uuid", "p_leg" "public"."ride_leg" DEFAULT 'both'::"public"."ride_leg") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_seat text;
  v_ride public.rides%rowtype;
  v_lim_min int; v_lim_km numeric;
  v_leg text; v_before numeric; v_after numeric; v_refused text; v_km_before numeric; v_km_after numeric;
  v_add_min int[] := array[0, 0]; v_add_km numeric[] := array[0, 0]; v_ix int;
  v_err text; v_start timestamptz; v_end timestamptz; v_day date; v_unknown boolean;
  v_features text[]; v_luggage boolean; v_guest public.requests%rowtype; v_swap boolean; v_boarding timestamptz; v_anchor timestamptz; v_tol interval; v_overlaps jsonb := '[]'::jsonb; v_conflict boolean := false; v_side text; v_lug_problem boolean := false;
  v_tow boolean; v_tow_taken boolean; v_needs text[];
  v_time_far boolean := false; v_far_eta timestamptz; v_far_wanted timestamptz; v_soft_far boolean;
  v_far_kind text; v_other_leg timestamptz;
  v_other record;
  v_detour_problem boolean := false; v_unknown_hops jsonb := '[]'::jsonb; v_hops jsonb;
  v_rb jsonb; v_ra jsonb; -- the ride's route without / with the guest (both legs), built once
  v_fixed jsonb;
  v_chain jsonb; v_chain_route jsonb; v_ch_after int; v_ch_before int; v_ch_guest int; v_ch_extra int;
  v_base_req public.requests%rowtype; v_chained_keys text[]; v_names text[]; v_unnamed int; v_one jsonb; v_via_on boolean := false;
  v_plain_side text; v_ra_alt jsonb; v_cur jsonb; v_alt jsonb; v_alt_extra int;
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

  -- R13B18 (QA run 13): a leg the request does not have cannot join — a pickup-only request (its drop-off leg
  -- cancelled: `one_way_from`, no departure) has no out leg, a request with no return time has no return leg.
  if v_err is null and exists(select 1 from public.requests q where q.id = p_request_id and (
       (p_leg = 'out' and (q.depart_at is null or q.trip_shape = 'one_way_from'))
    or (p_leg = 'return' and q.return_at is null))) then
    v_err := 'merge_leg_missing';
  end if;

  -- CM1 phase 2 (REQ item 260 b): the same person's two trips one after the other chain into one ride
  if v_err is null then v_chain := public._merge_chain_plan(p_ride_id, p_request_id, p_leg); end if;
  -- CM1 phase 3 (REQ item 260 c): the long trip's people who are not on the short trip ride the whole chained ride, or
  -- the ride passes the start again for them (`_via`): asked in the popup (app.chain_via / the proposal's chain_via)
  if v_chain is not null then
    select * into v_base_req from public.requests where id = (v_chain ->> 'base_request_id')::uuid;
    v_chained_keys := public._request_person_keys((v_chain ->> 'request_id')::uuid)
      || case when nullif(v_chain ->> 'driver_id', '') is not null then array['p:' || (v_chain ->> 'driver_id')] else '{}'::text[] end;
    select coalesce(array_agg(x.name order by x.ord, x.name), '{}') into v_names from (
      select 0 as ord, p.full_name as name from public.profiles p
       where p.id = v_base_req.requester_id and not (('p:' || p.id) = any (v_chained_keys))
      union all
      select 1, p.full_name from public.request_companions rc join public.profiles p on p.id = rc.profile_id
       where rc.request_id = v_base_req.id and not (('p:' || rc.profile_id) = any (v_chained_keys))
      union all
      select 2, c.full_name from public.request_children ch join public.children c on c.id = ch.child_id
       where ch.request_id = v_base_req.id and not (('c:' || ch.child_id) = any (v_chained_keys))) x;
    v_unnamed := greatest(v_base_req.adults - 1
      - (select count(*) from public.request_companions rc where rc.request_id = v_base_req.id)::int, 0);
    if cardinality(v_names) > 0 or v_unnamed > 0 then
      v_plain_side := v_chain ->> 'side';
      v_via_on := coalesce(current_setting('app.chain_via', true), '') = 'on'
        or exists (select 1 from public.proposals p where p.id::text = nullif(current_setting('app.applying_proposal', true), '')
                   and coalesce((p.payload ->> 'chain_via')::boolean, false));
      v_one := jsonb_build_object('names', to_jsonb(v_names), 'unnamed', v_unnamed,
        'place', (select coalesce(d.name, v_base_req.origin_text) from (select 1) one left join public.destinations d on d.id = v_base_req.origin_id),
        'was', case when v_plain_side = 'before' then v_base_req.depart_at else v_base_req.return_at end,
        'via_chosen', v_via_on);
      if v_via_on then v_chain := v_chain || jsonb_build_object('side', v_plain_side || '_via'); end if;
    end if;
  end if;

  -- REQ item 21 (2026-10-07): large luggage is a yes/no match - a large-luggage (ציוד רב) request
  -- rides only on a `large_trunk` car, and any number of them may share that car (no count cap).
  select coalesce(c.features, '{}') into v_features from public.cars c where c.id = v_ride.car_id;
  -- REQ §13.111 (a): a waived request does not need it; under `app.small_trunk = 'allow'` (a caller that passed
  -- allow_small_trunk, or merge_preview asking "is luggage the only problem?") the problem is only reported.
  v_luggage := public.request_needs_large_trunk(p_request_id);
  -- REQ §13.200: a towing request needs a car with the hitch, and the hitch is used by one towing request at a time
  -- (another unwaived towing request already riding this ride holds it). Same waivable verdict as luggage.
  v_tow := public.request_needs_tow_hitch(p_request_id);
  v_tow_taken := v_tow and exists (
    select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
    where rr.ride_id = p_ride_id and rr.request_id <> p_request_id and q.needs_tow_hitch and q.luggage_waived_at is null);
  v_needs := array_remove(array[
    case when v_luggage and not ('large_trunk' = any (coalesce(v_features, '{}'))) then 'large_trunk' end,
    case when v_tow and (not ('tow_hitch' = any (coalesce(v_features, '{}'))) or v_tow_taken) then 'tow_hitch' end], null);
  if cardinality(v_needs) > 0 then
    if coalesce(current_setting('app.small_trunk', true), '') = 'allow' then
      v_lug_problem := true;
    else
      v_err := coalesce(v_err, 'merge_luggage_needs_large_trunk');
    end if;
  end if;

  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_rb from public._ride_route_with(p_ride_id, null, 'both') r;
  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_ra from public._ride_route_with(p_ride_id, p_request_id, p_leg, v_chain) r;

  if v_chain is not null then
    -- a chain drops a leg of each trip, so it is compared with the two trips driven apart: the added driving (seldom
    -- any) against the detour limits; the window is the chain's own (below), never stretched by it.
    select coalesce(sum(x.m), 0) into v_ch_after from (
      select extract(epoch from (max(r.eta) - min(r.eta))) / 60 as m
        from jsonb_to_recordset(v_ra) as r(leg public.ride_leg, eta timestamptz) group by r.leg) x;
    select coalesce(sum(x.m), 0) into v_ch_before from (
      select extract(epoch from (max(r.eta) - min(r.eta))) / 60 as m
        from jsonb_to_recordset(v_rb) as r(leg public.ride_leg, eta timestamptz) group by r.leg) x;
    v_ch_guest := coalesce(public.request_leg_route_minutes(p_request_id, 'out'), 0) + coalesce(public.request_leg_route_minutes(p_request_id, 'return'), 0);
    v_ch_extra := greatest(round(v_ch_after - v_ch_before - v_ch_guest), 0)::int;
    select max(r.refused) into v_refused from jsonb_to_recordset(v_ra) as r(refused text);
    if v_refused is not null then v_err := coalesce(v_err, v_refused); end if;
    if v_ch_extra > v_lim_min then
      if coalesce(current_setting('app.long_detour', true), '') = 'allow' then v_detour_problem := true;
      elsif v_err is null then v_err := 'merge_detour_too_long'; end if;
    end if;
    v_ix := case when v_chain ->> 'side' like 'before%' then 1 else 2 end;
    v_add_min[v_ix] := v_ch_extra;
    if v_one is not null then
      -- both answers, each with its route, the time those people get on / off, and whether its driving is within the limit
      select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_ra_alt
        from public._ride_route_with(p_ride_id, p_request_id, p_leg,
               v_chain || jsonb_build_object('side', case when v_via_on then v_plain_side else v_plain_side || '_via' end)) r;
      v_cur := public._chain_variant(v_ra, v_chain ->> 'side', (v_chain ->> 'request_id')::uuid);
      v_alt := public._chain_variant(v_ra_alt, case when v_via_on then v_plain_side else v_plain_side || '_via' end, (v_chain ->> 'request_id')::uuid);
      v_alt_extra := greatest(round((v_alt ->> 'minutes')::int - v_ch_before - v_ch_guest), 0)::int;
      v_one := v_one || jsonb_build_object(
        case when v_via_on then 'via' else 'plain' end,
          jsonb_build_object('route', v_cur -> 'route', 'at', v_cur -> 'at', 'added_minutes', v_ch_extra, 'ok', v_ch_extra <= v_lim_min),
        case when v_via_on then 'plain' else 'via' end,
          jsonb_build_object('route', v_alt -> 'route', 'at', v_alt -> 'at', 'added_minutes', v_alt_extra, 'ok', v_alt_extra <= v_lim_min));
    end if;
    -- the chained ride's places, in order (the way back starts where the way there ends)
    select coalesce(jsonb_agg(jsonb_build_object('leg', r.leg, 'place_id', r.place_id,
             'name', coalesce(d.name, r.place_text), 'request_id', r.request_id, 'kind', r.kind, 'eta', r.eta)
             order by r.leg, r."position"), '[]'::jsonb)
      into v_chain_route
      from jsonb_to_recordset(v_ra) as r(leg public.ride_leg, "position" integer, place_id uuid, place_text text, request_id uuid, kind text, eta timestamptz)
      left join public.destinations d on d.id = r.place_id;
  else
  foreach v_leg in array array['out', 'return'] loop
    -- every leg is priced: a reversed one-way guest (R6B5) adds driving on the host's return leg although it joins as 'out'.
    v_ix := case when v_leg = 'out' then 1 else 2 end;

    select round(extract(epoch from (max(r.eta) - min(r.eta))) / 60) into v_before
    from jsonb_to_recordset(v_rb) as r(leg public.ride_leg, "position" integer, place_id uuid, place_text text, request_id uuid, kind text, eta timestamptz, refused text) where r.leg = v_leg::public.ride_leg;
    select round(extract(epoch from (max(r.eta) - min(r.eta))) / 60), max(r.refused) into v_after, v_refused
    from jsonb_to_recordset(v_ra) as r(leg public.ride_leg, "position" integer, place_id uuid, place_text text, request_id uuid, kind text, eta timestamptz, refused text) where r.leg = v_leg::public.ride_leg;
    if v_refused is not null then v_err := coalesce(v_err, v_refused); end if;

    select coalesce(sum(coalesce((select pt.distance_km from public.place_travel(x.place_id, x.next_id) pt), 0)), 0) into v_km_before
    from (select r.place_id, lead(r.place_id) over (order by r.position) as next_id
          from jsonb_to_recordset(v_rb) as r(leg public.ride_leg, "position" integer, place_id uuid, place_text text, request_id uuid, kind text, eta timestamptz, refused text) where r.leg = v_leg::public.ride_leg) x
    where x.place_id is not null and x.next_id is not null;
    select coalesce(sum(coalesce((select pt.distance_km from public.place_travel(x.place_id, x.next_id) pt), 0)), 0) into v_km_after
    from (select r.place_id, lead(r.place_id) over (order by r.position) as next_id
          from jsonb_to_recordset(v_ra) as r(leg public.ride_leg, "position" integer, place_id uuid, place_text text, request_id uuid, kind text, eta timestamptz, refused text) where r.leg = v_leg::public.ride_leg) x
    where x.place_id is not null and x.next_id is not null;
    -- REQ §13.175 (a): hops of the merged route with no known travel time (no stored route, no coordinates) - each
    -- counts as the 60-minute default, so the board names them next to a long detour.
    select coalesce(jsonb_agg(distinct jsonb_build_object('from', a.name, 'to', b.name)), '[]'::jsonb) into v_hops
    from (select r.place_id, lead(r.place_id) over (order by r.position) as next_id
          from jsonb_to_recordset(v_ra) as r(leg public.ride_leg, "position" integer, place_id uuid, place_text text, request_id uuid, kind text, eta timestamptz, refused text) where r.leg = v_leg::public.ride_leg) x
    join public.destinations a on a.id = x.place_id join public.destinations b on b.id = x.next_id
    where x.place_id <> x.next_id and (select pt.travel_minutes from public.place_travel(x.place_id, x.next_id) pt) is null;
    v_unknown_hops := v_unknown_hops || v_hops;

    -- REQ §13.95: a free-text place on the merged route has no known travel time, so the added
    -- driving is unknown — the Sadran's judgement decides (no detour-limit refusal, no automatic
    -- window change; a payload window still applies on apply). Boarding-before-the-end still holds.
    select exists(select 1 from jsonb_to_recordset(v_ra) as r(leg public.ride_leg, "position" integer, place_id uuid, place_text text, request_id uuid, kind text, eta timestamptz, refused text)
                  where r.leg = v_leg::public.ride_leg and r.place_id is null) into v_unknown;
    if v_unknown then
      v_add_min[v_ix] := 0; v_add_km[v_ix] := 0;
    else
      v_add_min[v_ix] := greatest(coalesce(v_after, 0) - coalesce(v_before, 0), 0)::int;
      v_add_km[v_ix] := greatest(coalesce(v_km_after, 0) - coalesce(v_km_before, 0), 0);
      -- REQ §13.175 (a): over the limit is a refusal, unless the caller waives it (app.long_detour = 'allow': the
      -- Sadran's "לאחד בכל זאת", a proposal carrying allow_long_detour, merge_preview asking) - then it is only reported.
      if v_add_min[v_ix] > v_lim_min or v_add_km[v_ix] > v_lim_km then
        if coalesce(current_setting('app.long_detour', true), '') = 'allow' then v_detour_problem := true;
        elsif v_err is null then v_err := 'merge_detour_too_long'; end if;
      end if;
    end if;
  end loop;
  end if;

  -- REQ §13.112 (c): a ride that serves a window request ("N hours between A and B") keeps its length, so a merge that adds
  -- driving (and so grows the block) is refused; a merge that adds none still goes through.
  if v_err is null and v_chain is null and (v_add_min[1] > 0 or v_add_min[2] > 0) and exists(
       select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
       where rr.ride_id = p_ride_id and q.duration_locked) then
    v_err := 'merge_window_locked';
  end if;

  -- R12B5 (REQ §13.119): the guest must actually be ON the merged route for the leg asked: a ride without a
  -- return leg cannot take a "return" join, and a guest who boards at (or after) the route's end is refused. A guest
  -- whose own time is hours away from the ride's estimated time at the boarding point is a "window" refusal
  -- (tolerance: the guest's own flexibility, at least 2 hours); a free-text boarding place has no estimate.
  select * into v_guest from public.requests where id = p_request_id;
  -- (a chain keeps both trips' own hours: its window is theirs)
  if v_err is null and v_guest.id is not null and v_chain is null
     and exists(select 1 from public.ride_requests rb where rb.ride_id = p_ride_id and rb.request_id <> p_request_id) then
    v_swap := public._merge_guest_swapped(p_ride_id, p_request_id);
    -- the route legs the guest rides: a reversed one-way rides the host's RETURN leg (see _ride_route_with)
    foreach v_leg in array case when v_swap then array['return']
        else array_remove(array[case when p_leg in ('out', 'both') then 'out' end, case when p_leg in ('return', 'both') then 'return' end], null) end loop
      if not exists(select 1 from jsonb_to_recordset(v_ra) as r(leg public.ride_leg, "position" integer, place_id uuid, place_text text, request_id uuid, kind text, eta timestamptz, refused text) where r.leg = v_leg::public.ride_leg) then
        v_err := 'merge_boards_at_end';
        exit;
      end if;
      select min(r.eta) into v_boarding from jsonb_to_recordset(v_ra) as r(leg public.ride_leg, "position" integer, place_id uuid, place_text text, request_id uuid, kind text, eta timestamptz, refused text)
      where r.leg = v_leg::public.ride_leg
        and r.place_id is not null and r.place_id = (case when v_leg = 'out' or v_swap then v_guest.origin_id else v_guest.destination_id end);
      continue when v_boarding is null;
      -- R19B1: the leg on the wrong side of the person's other leg — asked of everyone, never refused
      if not v_swap then
        if v_leg = 'return' then
          v_other_leg := coalesce((select min(rd.starts_at) from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
                                   where rr.request_id = p_request_id and rr.covers_out and rd.status <> 'cancelled' and rd.id <> p_ride_id),
                                  v_guest.depart_at);
          if v_other_leg is not null and v_guest.return_at is not null and v_boarding < v_other_leg then v_far_kind := 'order'; end if;
        else
          v_other_leg := case when v_guest.return_at is null then null else coalesce(
                           (select max(rd.ends_at) from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
                            where rr.request_id = p_request_id and rr.covers_return and rd.status <> 'cancelled' and rd.id <> p_ride_id),
                           v_guest.return_at) end;
          if v_other_leg is not null and v_boarding > v_other_leg then v_far_kind := 'order'; end if;
        end if;
        if v_far_kind = 'order' then
          v_time_far := true; v_far_eta := v_boarding; v_far_wanted := v_other_leg;
          exit;
        end if;
      end if;
      if v_leg = 'out' or v_swap then
        continue when v_guest.depart_at is null;
        v_tol := greatest(interval '2 hours', v_guest.flex_depart_early, v_guest.flex_depart_late);
        v_anchor := v_guest.depart_at;
      else
        continue when v_guest.return_at is null;
        v_tol := greatest(interval '2 hours', v_guest.flex_return_early, v_guest.flex_return_late);
        v_anchor := v_guest.return_at;
      end if;
      -- R13B9 (owner 2026-10-23): far from the guest's own time is a refusal of its own (`merge_time_far`, never
      -- "wrong day"); a Sadran (and the apply of a Sadran-made proposal the member accepted) may still propose it -
      -- then it is only reported (`time_far`) and the board warns that it is unlikely.
      if abs(extract(epoch from (v_boarding - v_anchor))) > extract(epoch from v_tol) then
        v_time_far := true; v_far_eta := v_boarding; v_far_wanted := v_anchor; v_far_kind := 'far';
        v_soft_far := public.can_manage_week(v_ride.department_id, v_ride.week_start)
          or exists (select 1 from public.proposals p where p.id::text = nullif(current_setting('app.applying_proposal', true), '')
                     and p.created_via = 'sadran');
        if not v_soft_far then v_err := 'merge_time_far'; end if;
        exit;
      end if;
    end loop;
  end if;

  -- Window: leave earlier by the added driving out, end later by the added driving back (quarter-hour grid).
  v_day := (v_ride.starts_at at time zone 'Asia/Jerusalem')::date;
  v_start := v_ride.starts_at - make_interval(mins => (ceil(v_add_min[1] / 15.0) * 15)::int);
  v_end := v_ride.ends_at;
  if (v_end at time zone 'Asia/Jerusalem')::time = time '23:59' and v_add_min[2] > 0 then v_end := v_end + interval '1 minute'; end if;
  v_end := v_end + make_interval(mins => (ceil(v_add_min[2] / 15.0) * 15)::int);
  if v_chain is not null then
    -- the chained ride leaves at the first trip's start and is back at the last trip's end
    v_start := (v_chain ->> 'starts_at')::timestamptz; v_end := (v_chain ->> 'ends_at')::timestamptz;
  end if;
  if v_err is null and (((v_start at time zone 'Asia/Jerusalem')::date <> v_day)
      or (((v_end - interval '1 minute') at time zone 'Asia/Jerusalem')::date <> v_day)) then
    v_err := 'ride_request_day_mismatch';
  end if;
  if (v_end at time zone 'Asia/Jerusalem')::time = time '00:00' then
    v_end := (((v_day) + time '23:59') at time zone 'Asia/Jerusalem');
  end if;

  -- REQ item 246 g (LT1 phase 2c): a stated hour of the ride never moves beyond its flexibility for a guest
  if v_err is null and v_chain is null and (v_add_min[1] > 0 or v_add_min[2] > 0) then
    v_fixed := public._merge_fixed_hour_break(p_ride_id, v_rb, v_ra);
    -- like the detour limit: refused, unless the Sadran merges anyway ("לאחד בכל זאת", app.long_detour = 'allow') - then reported
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
  -- R16B8: the guests of the other open (draft / sent / accepted) merges onto this ride are seated in the probe too —
  -- two merge drafts that each fit alone can no longer stack past the car's seats. A guest whose row cannot be
  -- written for any other reason is skipped (its own sub-block), never a reason to skip the seat check.
  if v_err is null then
    -- PF1 (2026-11-11): the seat check reads; it no longer writes the guests and rolls back. Same verdicts
    -- (ride_seats_verdict mirrors assert_ride_seats_fit over the ride's rows plus the proposed guests).
    -- a chain: the chained trip seats its own leg only (the ride's row of it, when it is the host's trip, is replaced)
    v_seat := public.ride_seats_verdict(p_ride_id,
      case when v_chain is null then jsonb_build_array(jsonb_build_object('request_id', p_request_id, 'leg', p_leg))
           when (v_chain ->> 'request_id')::uuid = p_request_id
             then jsonb_build_array(jsonb_build_object('request_id', p_request_id, 'leg', 'both', 'chain', v_chain ->> 'side'))
           else jsonb_build_array(jsonb_build_object('request_id', p_request_id, 'leg', 'both'),
                  jsonb_build_object('request_id', (v_chain ->> 'request_id')::uuid, 'leg', 'both', 'chain', v_chain ->> 'side')) end
      || coalesce((
        select jsonb_agg(jsonb_build_object('request_id', o.request_id, 'leg', o.leg) order by o.request_id)
        from (
          select p.request_id,
                 case when bool_or(coalesce(l->>'leg', 'both') in ('out', 'both')) and bool_or(coalesce(l->>'leg', 'both') in ('return', 'both')) then 'both'
                      when bool_or(coalesce(l->>'leg', 'both') in ('out', 'both')) then 'out' else 'return' end as leg
          from public.proposals p
          cross join lateral jsonb_array_elements(coalesce(p.payload -> 'legs', '[]'::jsonb)) l
          where p.type = 'merge' and p.status in ('draft', 'sent', 'accepted')
            and p.request_id is not null and p.request_id <> p_request_id
            and (l->>'ride_id')::uuid = p_ride_id and coalesce(l->>'role', 'passenger') <> 'driver'
            and p.id::text is distinct from nullif(current_setting('app.applying_proposal', true), '')
          group by p.request_id
        ) o), '[]'::jsonb));
    if v_seat in ('seat_config_violation', 'luggage_capacity_violation') then v_err := v_seat;
    elsif v_seat = 'needs_large_trunk' then v_err := 'merge_luggage_needs_large_trunk'; end if;
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
      -- a chain: the guest's own trip is the one joining
      and not (v_chain is not null and exists (select 1 from public.ride_requests rx where rx.ride_id = r.id and rx.request_id = p_request_id))
  ) x;

  return jsonb_build_object('ok', v_err is null, 'error', v_err, 'code', public._merge_error_code(v_err),
    'person_overlaps', v_overlaps, 'luggage_problem', v_lug_problem, 'needs', to_jsonb(v_needs),
    'time_far', v_time_far, 'time_far_eta', v_far_eta, 'time_far_wanted', v_far_wanted, 'time_far_kind', v_far_kind, 'time_far_leg', case when v_far_kind = 'order' then v_leg end, 'turnaround_conflict', v_conflict, 'turnaround_side', v_side,
    'added_out_minutes', v_add_min[1], 'added_return_minutes', v_add_min[2],
    'added_out_km', round(v_add_km[1], 1), 'added_return_km', round(v_add_km[2], 1),
    'detour_problem', v_detour_problem, 'detour_limit_minutes', v_lim_min, 'detour_limit_km', v_lim_km,
    'unknown_hops', (select coalesce(jsonb_agg(distinct h), '[]'::jsonb) from jsonb_array_elements(v_unknown_hops) h),
    'fixed_hour', v_fixed,
    'chain', case when v_chain is not null then v_chain || jsonb_build_object('route', v_chain_route, 'one_trip', v_one) end,
    'starts_at', v_ride.starts_at, 'new_starts_at', v_start,
    'ends_at', v_ride.ends_at, 'new_ends_at', v_end);
end;
$$;


drop function public.member_merge_ride(uuid, uuid, uuid, integer, boolean, boolean, boolean, boolean);

CREATE OR REPLACE FUNCTION "public"."member_merge_ride"("p_ride_id" "uuid", "p_source_ride_id" "uuid", "p_request_id" "uuid", "p_expected_version" integer, "p_wait" boolean DEFAULT false, "p_allow_long_detour" boolean DEFAULT false, "p_agreed" boolean DEFAULT false, "p_allow_small_trunk" boolean DEFAULT false, "p_chain_via" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  h public.rides%rowtype; src public.rides%rowtype; v jsonb; c jsonb; v_leg public.ride_leg;
  v_direct boolean; v_before jsonb := '{}'::jsonb; r record; v_prev text; v_start timestamptz; v_end timestamptz;
  v_plan jsonb;
begin
  perform 1 from public.rides where id in (p_ride_id, p_source_ride_id) order by id for update;
  select * into h from public.rides where id = p_ride_id;
  if h.id is not null and (p_expected_version is null or h.version <> p_expected_version) then perform public.raise_stale_version(); end if;
  -- CM1 phase 3: the member's answer for the people on one trip only (pass the start again for them)
  perform set_config('app.chain_via', case when coalesce(p_chain_via, false) then 'on' else '' end, true);
  v := public._member_merge_check(p_ride_id, p_source_ride_id, p_request_id);
  v_leg := (v ->> 'leg')::public.ride_leg;
  -- REQ §13.175 (d, g): the member may accept a long detour and, after "אני מודע/ת", a car without a large trunk
  if not (v ->> 'ok')::boolean and not (coalesce((v ->> 'waivable')::boolean, false)
       and (not coalesce((v ->> 'detour_waivable')::boolean, false) or p_allow_long_detour)
       and (not coalesce((v ->> 'luggage_waivable')::boolean, false) or p_allow_small_trunk)) then
    raise exception '%', coalesce(v ->> 'error', 'merge_not_allowed') using errcode = 'P0001';
  end if;
  v_direct := case when p_wait then (v ->> 'direct_with_wait')::boolean else (v ->> 'direct')::boolean end;
  if not v_direct and not coalesce(p_agreed, false) then raise exception 'member_merge_needs_agreement' using errcode = 'P0001'; end if;
  select * into src from public.rides where id = p_source_ride_id;

  -- what the guest and everyone else on the ride saw before (one ride_edited notice each)
  for r in select distinct rr.request_id from public.ride_requests rr where rr.ride_id = h.id or (rr.ride_id = src.id and rr.request_id = p_request_id) loop
    v_before := v_before || jsonb_build_object(r.request_id::text, public._ride_edit_snapshot(r.request_id));
  end loop;

  -- CM1 phase 2: a chain's plan (its driver) is read while the guest is still on its own ride
  v_plan := public._merge_chain_plan(h.id, p_request_id, v_leg);
  perform set_config('app.audit_reason', 'member_merge_ride', true);
  v_prev := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
  perform set_config('app.system_status_transition', 'on', true);
  delete from public.ride_requests where ride_id = src.id and request_id = p_request_id;
  if not exists (select 1 from public.ride_requests where ride_id = src.id) and not exists (select 1 from public.ride_passengers where ride_id = src.id) then
    update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = (select auth.uid()), cancel_reason = 'MERGED_BY_MEMBER' where id = src.id;
    if src.car_id <> h.car_id then
      perform public.flag_car_chain_breaks(src.car_id, src.week_start);
      perform public._offer_freed_slot(src.id);
    end if;
  else
    update public.rides set is_pinned = true, pin_reason = coalesce(pin_reason, 'MEMBER_EDIT') where id = src.id;
  end if;

  perform public._long_detour_mode(p_allow_long_detour);
  -- the waiver is stamped on the request by assert_ride_seats_fit below (luggage_waived_at/by), as for the Sadran
  perform public._small_trunk_mode(p_allow_small_trunk);
  c := public._merge_check(h.id, p_request_id, v_leg);
  perform public._long_detour_mode(false);
  if c ->> 'error' is not null then raise exception '%', c ->> 'error' using errcode = 'P0001'; end if;
  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode, detour_minutes)
  values (h.id, p_request_id, 'passenger', v_leg, 'passenger',
    greatest(coalesce((c ->> 'added_out_minutes')::int, 0), coalesce((c ->> 'added_return_minutes')::int, 0)));
  if jsonb_typeof(c -> 'chain') = 'object' then
    perform public._apply_chain(h.id, (c -> 'chain') - 'route'
      || jsonb_build_object('driver_id', coalesce(v_plan ->> 'driver_id', c -> 'chain' ->> 'driver_id')));
  end if;
  v_start := least(h.starts_at, (c ->> 'new_starts_at')::timestamptz, case when p_wait then (v ->> 'wait_starts_at')::timestamptz end);
  v_end := greatest(h.ends_at, (c ->> 'new_ends_at')::timestamptz, case when p_wait then (v ->> 'wait_ends_at')::timestamptz end);
  update public.rides set starts_at = v_start, ends_at = v_end, is_pinned = true, pin_reason = coalesce(pin_reason, 'MEMBER_EDIT') where id = h.id;
  perform public.assert_ride_request_day(h.id);
  perform public.assert_ride_seats_fit(h.id);
  perform public.assert_car_chain(h.car_id, h.week_start);
  perform public._small_trunk_mode(false);
  perform set_config('app.chain_via', '', true);
  update public.requests set status = 'merged', status_reason = 'MEMBER_MERGED' where id = p_request_id;
  perform set_config('app.system_status_transition', v_prev, true);

  for r in select key::uuid as request_id, value as before from jsonb_each(v_before) loop
    perform public._notify_ride_edited(r.request_id, r.before);
  end loop;
  select * into h from public.rides where id = p_ride_id;
  return jsonb_build_object('ride_id', h.id, 'starts_at', h.starts_at, 'ends_at', h.ends_at, 'leg', v_leg);
end $$;

revoke all on function public.member_merge_ride(uuid, uuid, uuid, integer, boolean, boolean, boolean, boolean, boolean) from public, anon;
grant execute on function public.member_merge_ride(uuid, uuid, uuid, integer, boolean, boolean, boolean, boolean, boolean) to authenticated;
