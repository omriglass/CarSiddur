-- CM1 phase 2 (REQ item 260 b): two trips of the same person, one after the other, merge into ONE chained ride.
-- Ride A 07:45 home -> school -> home and ride B 08:30 home -> Binyamina -> home become home -> school -> Binyamina -> home:
-- trip 1's way back and trip 2's way out of home are dropped (docs/CHAIN_MERGE_PLAN_2026-11.md "Phase 2 design").
--
-- Storage: `ride_requests.chain` on the row of the SHORT trip (`before` = it rides first, `after` = it rides last; the
-- `_via` variants are phase 3). The long trip (the longer far-end stay) stays the route base, and the apply makes its
-- row sort first, so the readers that pick the base (`order by (role = 'driver') desc, created_at, request_id`) agree.
-- The chained row covers both legs (its request is served); seats and stops skip the leg it no longer rides.

alter table public.ride_requests add column chain text
  check (chain in ('before', 'before_via', 'after', 'after_via'));
comment on column public.ride_requests.chain is
  'CM1 (REQ item 260 b): this request is chained to the ride''s base trip - before (rides first, its way back dropped) or after (rides last, its way out dropped); _via = passes the shared start place again (phase 3). Null = an ordinary row.';

-- Does a ride_requests row seat people on this leg? (Covers it, and a chained row only on the leg it still rides.)
-- Plain SQL, no SET clause: inlined into its callers.
create or replace function public._rr_on_leg(p_leg text, p_covers_out boolean, p_covers_return boolean, p_chain text)
returns boolean language sql immutable as $$
  select case p_leg when 'out' then p_covers_out and coalesce(p_chain, '') not like 'after%'
                    when 'return' then p_covers_return and coalesce(p_chain, '') not like 'before%'
                    else false end;
$$;

-- The named people of a request: 'p:<profile>' (requester, companions), 'c:<child>'.
create or replace function public._request_person_keys(p_request_id uuid) returns text[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct x.k), '{}'::text[]) from (
    select 'p:' || q.requester_id as k from public.requests q where q.id = p_request_id
    union all select 'p:' || rc.profile_id from public.request_companions rc where rc.request_id = p_request_id
    union all select 'c:' || ch.child_id from public.request_children ch where ch.request_id = p_request_id) x;
$$;

-- When a merge of the request onto the ride is a chain: {side, request_id (the chained = short trip), base_request_id
-- (the long trip), starts_at, ends_at (the chained ride's window), driver_id}; null = an ordinary insertion merge.
-- A chain needs: both legs asked; two round trips from the same place to places of their own; a person on both
-- (requester, companion, child or a driver); the trips in sequence - the first one ends no later than the second
-- starts plus turnaround and the drive between them, and no more than 2 hours before it.
create or replace function public._merge_chain_plan(p_ride_id uuid, p_request_id uuid, p_leg public.ride_leg default 'both')
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  h public.rides%rowtype; g public.requests%rowtype; b public.requests%rowtype; v_gride public.rides%rowtype;
  v_base uuid; v_host_keys text[]; v_guest_keys text[]; v_shared text[];
  v_g_first boolean; v_turn int; v_drive int; v_first_ret timestamptz; v_second_dep timestamptz;
  v_first_dest uuid; v_second_dest uuid; v_base_is_guest boolean; v_chained uuid; v_side text;
  v_first_driver uuid; v_base_driver uuid; v_driver uuid;
begin
  if p_leg is distinct from 'both' then return null; end if;
  select * into h from public.rides where id = p_ride_id;
  select * into g from public.requests where id = p_request_id;
  if h.id is null or g.id is null or h.status = 'cancelled' then return null; end if;
  -- one chain per ride, and the request is not on the ride yet
  if exists (select 1 from public.ride_requests rr where rr.ride_id = h.id and (rr.chain is not null or rr.request_id = g.id)) then
    return null;
  end if;
  select rr.request_id into v_base from public.ride_requests rr where rr.ride_id = h.id
   order by (rr.role = 'driver') desc, rr.created_at, rr.request_id limit 1;
  if v_base is null then return null; end if;
  select * into b from public.requests where id = v_base;
  if g.trip_type <> 'round_trip' or b.trip_type <> 'round_trip'
     or g.depart_at is null or g.return_at is null or b.depart_at is null or b.return_at is null
     or g.origin_id is null or g.origin_id is distinct from b.origin_id
     or g.destination_id is null or b.destination_id is null or g.destination_id = b.destination_id
     or g.destination_id = g.origin_id or b.destination_id = b.origin_id
     or g.duration_locked or b.duration_locked or g.series_id is not null or b.series_id is not null
     or not exists (select 1 from public.ride_requests rr where rr.ride_id = h.id and rr.request_id = v_base and rr.leg = 'both') then
    return null;
  end if;

  -- a person on both trips
  select coalesce(array_agg(distinct x.k), '{}'::text[]) into v_host_keys from (
    select unnest(public._request_person_keys(rr.request_id)) as k from public.ride_requests rr where rr.ride_id = h.id
    union all select 'p:' || h.driver_id where h.driver_id is not null) x;
  select rd.* into v_gride from public.rides rd
   where rd.status <> 'cancelled' and rd.id <> h.id
     and rd.id in (select rr.ride_id from public.ride_requests rr where rr.request_id = g.id)
   order by rd.starts_at, rd.id limit 1;
  v_guest_keys := public._request_person_keys(g.id)
    || case when v_gride.driver_id is not null then array['p:' || v_gride.driver_id] else '{}'::text[] end;
  select coalesce(array_agg(distinct k), '{}'::text[]) into v_shared from unnest(v_guest_keys) k where k = any (v_host_keys);
  if cardinality(v_shared) = 0 then return null; end if;

  -- in sequence
  v_g_first := g.depart_at < b.depart_at or (g.depart_at = b.depart_at and g.return_at < b.return_at);
  if v_g_first then
    v_first_ret := g.return_at; v_second_dep := b.depart_at; v_first_dest := g.destination_id; v_second_dest := b.destination_id;
  else
    v_first_ret := b.return_at; v_second_dep := g.depart_at; v_first_dest := b.destination_id; v_second_dest := g.destination_id;
  end if;
  v_turn := coalesce(public.required_turnaround_minutes(h.department_id, h.week_start), 30);
  v_drive := coalesce((select pt.travel_minutes from public.place_travel(v_first_dest, v_second_dest) pt), 60);
  if v_first_ret > v_second_dep + make_interval(mins => v_turn + v_drive)
     or v_second_dep - v_first_ret > interval '2 hours' then
    return null;
  end if;

  -- the base is the longer stay (a tie: the ride dropped onto); the side is by time
  v_base_is_guest := (g.return_at - g.depart_at) > (b.return_at - b.depart_at);
  v_chained := case when v_base_is_guest then b.id else g.id end;
  v_side := case when (v_chained = g.id) = v_g_first then 'before' else 'after' end;
  -- the driver: trip 1's driver when on both trips, else the base trip's driver (the Sadran can change it)
  v_first_driver := case when v_g_first then v_gride.driver_id else h.driver_id end;
  v_base_driver := case when v_base_is_guest then v_gride.driver_id else h.driver_id end;
  v_driver := case when v_first_driver is not null and ('p:' || v_first_driver) = any (v_shared) then v_first_driver
                   else coalesce(v_base_driver, h.driver_id) end;
  return jsonb_build_object('side', v_side, 'request_id', v_chained,
    'base_request_id', case when v_base_is_guest then g.id else b.id end,
    'starts_at', least(h.starts_at, g.depart_at), 'ends_at', greatest(h.ends_at, g.return_at),
    'driver_id', v_driver);
end $$;

-- Writes a chain plan onto the ride after the guest's row is in: the chain value on the short trip's row, the plan's
-- driver, and the long trip's row first in every base reader (the driver row when its requester drives, else the oldest).
create or replace function public._apply_chain(p_ride_id uuid, p_plan jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_chained uuid; v_base uuid; v_driver uuid; v_ride public.rides%rowtype; v_first timestamptz;
begin
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' then return; end if;
  v_chained := (p_plan ->> 'request_id')::uuid; v_base := (p_plan ->> 'base_request_id')::uuid;
  v_driver := nullif(p_plan ->> 'driver_id', '')::uuid;
  select * into v_ride from public.rides where id = p_ride_id;
  update public.ride_requests set chain = p_plan ->> 'side' where ride_id = p_ride_id and request_id = v_chained;
  update public.ride_requests set role = 'passenger', car_mode = 'passenger'
   where ride_id = p_ride_id and role = 'driver' and request_id <> v_base;
  if v_driver is not null and v_driver is distinct from v_ride.driver_id then
    update public.rides set driver_id = v_driver where id = p_ride_id;
  end if;
  if exists (select 1 from public.requests q where q.id = v_base and q.requester_id = coalesce(v_driver, v_ride.driver_id)) then
    update public.ride_requests set role = 'driver', car_mode = 'keep'
     where ride_id = p_ride_id and request_id = v_base and role <> 'driver';
  end if;
  select min(created_at) into v_first from public.ride_requests where ride_id = p_ride_id and request_id <> v_base;
  if v_first is not null then
    update public.ride_requests set created_at = v_first - interval '1 millisecond'
     where ride_id = p_ride_id and request_id = v_base and created_at >= v_first;
  end if;
end $$;

-- The base trip left the ride (or nobody else is left on it): the chained request rides its own route again.
create or replace function public.ride_requests_chain_cleanup() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_was_base uuid;
begin
  if old.chain is not null then return null; end if;
  if not exists (select 1 from public.ride_requests rr where rr.ride_id = old.ride_id and rr.chain is not null) then return null; end if;
  if exists (select 1 from public.ride_requests rr where rr.ride_id = old.ride_id and rr.request_id = old.request_id) then return null; end if;
  select y.request_id into v_was_base from (
      select rr.request_id, rr.role, rr.created_at from public.ride_requests rr where rr.ride_id = old.ride_id and rr.chain is null
      union all select old.request_id, old.role, old.created_at) y
   order by (y.role = 'driver') desc, y.created_at, y.request_id limit 1;
  if v_was_base = old.request_id
     or not exists (select 1 from public.ride_requests rr where rr.ride_id = old.ride_id and rr.chain is null) then
    update public.ride_requests set chain = null where ride_id = old.ride_id and chain is not null;
  end if;
  return null;
end $$;

create trigger ride_requests_chain_cleanup after delete on public.ride_requests
  for each row execute function public.ride_requests_chain_cleanup();

revoke all on function public._rr_on_leg(text, boolean, boolean, text) from public, anon, authenticated;
revoke all on function public._request_person_keys(uuid) from public, anon, authenticated;
revoke all on function public._merge_chain_plan(uuid, uuid, public.ride_leg) from public, anon, authenticated;
revoke all on function public._apply_chain(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ride_requests_chain_cleanup() from public, anon, authenticated;

-- ====================================================================================================
-- The route builder. p_chain: a chain plan (`_merge_chain_plan`) to preview, null = the ride as stored (its own chain row, if any).
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
    if v_chain_req is not null and v_leg = 'out' and v_chain_side like 'before%' then
      select coalesce(jsonb_agg(jsonb_build_object('place_id', p.place_id, 'place_text', p.place_text, 'request_id', v_chain_req,
               'kind', case when p."position" = x.m then 'alight' else 'stop' end) order by p."position"), '[]'::jsonb)
        into v_p
        from public.request_leg_route_points(v_chain_req, 'out') p
        cross join (select max(p2."position") as m from public.request_leg_route_points(v_chain_req, 'out') p2) x
       where p."position" > 0;
      v_route := jsonb_build_array(v_route -> 0) || v_p || (v_route - 0);
    elsif v_chain_req is not null and v_leg = 'return' and v_chain_side like 'after%' then
      select coalesce(jsonb_agg(y.e order by y.part, y.pos), '[]'::jsonb) into v_p from (
        select 1 as part, p."position" as pos,
               jsonb_build_object('place_id', p.place_id, 'place_text', p.place_text, 'request_id', v_chain_req,
                 'kind', case when p."position" = x.m then 'board' else 'stop' end) as e
          from public.request_leg_route_points(v_chain_req, 'out') p
          cross join (select max(p2."position") as m from public.request_leg_route_points(v_chain_req, 'out') p2) x
         where p."position" > 0
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


CREATE OR REPLACE FUNCTION "public"."_ride_route_with"("p_ride_id" "uuid", "p_extra_request" "uuid" DEFAULT NULL::"uuid", "p_extra_leg" "public"."ride_leg" DEFAULT 'both'::"public"."ride_leg") RETURNS TABLE("leg" "public"."ride_leg", "position" integer, "place_id" "uuid", "place_text" "text", "request_id" "uuid", "kind" "text", "eta" timestamp with time zone, "refused" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  return query select r.leg, r."position", r.place_id, r.place_text, r.request_id, r.kind, r.eta, r.refused
    from public._ride_route_with(p_ride_id, p_extra_request, p_extra_leg, null::jsonb) r;
end;
$$;

revoke all on function public._ride_route_with(uuid, uuid, public.ride_leg, jsonb) from public, anon, authenticated;

-- ====================================================================================================
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

  for q in
    select x.id, x.adults, x.child_seats, x.boosters, x.origin_id, x.origin_text, x.destination_id, x.destination_text,
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
    v_riders := v_riders || jsonb_build_array(jsonb_build_object('adults', q.adults - v_less_a, 'childSeats', q.child_seats - v_less_c,
      'boosters', q.boosters - v_less_b, 'board', v_from, 'alight', v_to, 'key', 'req:' || q.id));

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
CREATE OR REPLACE FUNCTION "public"."_ride_seat_dupes"("p_ride_id" "uuid", "p_leg" "public"."ride_leg", "p_guests" "jsonb" DEFAULT '[]'::"jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v jsonb;
begin
  -- the requests seated on the leg (null = the whole ride), the proposed guests [{request_id, leg}] included
  with seated as (
    -- CM1 phase 2: a chained row seats its own leg only; a guest entry with `chain` replaces the ride's row (a preview)
    select rr.request_id from public.ride_requests rr
     where rr.ride_id = p_ride_id
       and (p_leg is null or public._rr_on_leg(p_leg::text, rr.covers_out, rr.covers_return, rr.chain))
       and not exists (select 1 from jsonb_array_elements(coalesce(p_guests, '[]'::jsonb)) e
                        where (e ->> 'request_id')::uuid = rr.request_id and e ? 'chain')
    union
    select (e ->> 'request_id')::uuid from jsonb_array_elements(coalesce(p_guests, '[]'::jsonb)) e
     where p_leg is null
        or (e ? 'chain' and public._rr_on_leg(p_leg::text, coalesce(e ->> 'leg', 'both') in ('out', 'both'),
                                              coalesce(e ->> 'leg', 'both') in ('return', 'both'), e ->> 'chain'))
        or (not e ? 'chain' and coalesce(e ->> 'leg', 'both') in (p_leg::text, 'both'))
  ),
  -- every named person once per request that seats them, with the seat they take there
  occ as (
    select 'p:' || q.requester_id as k, 'adult' as kind, false as companion
      from seated s join public.requests q on q.id = s.request_id
    union all
    select 'p:' || rc.profile_id, 'adult', true
      from seated s join public.request_companions rc on rc.request_id = s.request_id
    union all
    select 'c:' || ch.child_id,
           case when c.birth_year is not null
                 and extract(year from coalesce(q.depart_at, now()) at time zone 'Asia/Jerusalem')::int - c.birth_year >= 8
                then 'adult' else 'child_seat' end, false
      from seated s join public.request_children ch on ch.request_id = s.request_id
      join public.children c on c.id = ch.child_id join public.requests q on q.id = s.request_id
  )
  select jsonb_build_object(
      'adults', coalesce((select sum(n) from (select count(*) - count(distinct k) as n from occ where kind = 'adult') x), 0),
      'childSeats', coalesce((select sum(n) from (select count(*) - count(distinct k) as n from occ where kind = 'child_seat') x), 0),
      -- the ride's driver rides as someone's companion (a chauffeur ride's extra seat would count them twice)
      'driverCompanion', exists (select 1 from occ join public.rides r on r.id = p_ride_id
                                  where occ.companion and occ.k = 'p:' || r.driver_id))
    into v;
  return v;
end;
$$;

-- ====================================================================================================
CREATE OR REPLACE FUNCTION "public"."assert_ride_seats_fit"("v_ride" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare r record; v_mode text; v_bonus int; v_ids uuid[]; v_holder uuid; v_hitch boolean; v_lug_ok boolean; v_private boolean;
begin
  v_mode := coalesce(current_setting('app.small_trunk', true), '');
  for r in
    select leg_side,
           sum(q.adults) a, sum(q.child_seats) c, sum(q.boosters) b, rd.car_id,
           count(*) filter (where q.has_luggage and q.luggage_waived_at is null) lug,
           count(*) filter (where q.needs_tow_hitch and q.luggage_waived_at is null) tow
    from public.ride_requests rr
    join public.requests q on q.id = rr.request_id
    join public.rides rd on rd.id = rr.ride_id
    cross join lateral (values ('out'), ('return')) as legs(leg_side)
    where rr.ride_id = v_ride and rd.status <> 'cancelled'
      and public._rr_on_leg(legs.leg_side, rr.covers_out, rr.covers_return, rr.chain)   -- CM1: a chained trip, its own leg only
    group by leg_side, rd.car_id
  loop
    v_bonus := 0;
    if not exists (select 1 from public.ride_requests x where x.ride_id = v_ride and x.role = 'driver')
      and not exists (select 1 from public.ride_requests x join public.requests q on q.id=x.request_id join public.rides rd on rd.id=x.ride_id
        where x.ride_id=v_ride and q.requester_id=rd.driver_id and public._rr_on_leg(r.leg_side, x.covers_out, x.covers_return, x.chain)) then
      r.a := r.a + 1; v_bonus := 1;   -- chauffeur ride: the volunteer has no request of their own (§5.2)
    end if;
    -- REQ item 246 h: the per-leg sum first; only when it does not fit, and someone on the ride gets on / off midway,
    -- the seats per stretch decide (never more than the sum, so a ride that fits costs nothing extra)
    if not public.car_fits(r.car_id, r.a::int, r.c::int, r.b::int)
       -- CM1 (REQ item 260 a): one person on two of the ride's requests counts once
       and not public._seats_fit_once(r.car_id, v_ride, r.leg_side::public.ride_leg, r.a::int, r.c::int, r.b::int, v_bonus)
       and not (public._ride_has_rider_spans(v_ride)
                and public._ride_leg_fits_along(v_ride, r.leg_side::public.ride_leg, r.car_id, jsonb_build_array(jsonb_build_object('adults', v_bonus)))) then
      raise exception 'seat_config_violation' using detail =
        format('ride %s leg %s needs (%s,%s,%s)', v_ride, r.leg_side, r.a, r.c, r.b);
    end if;
    if not public.car_meets_needs(r.car_id, r.lug::int, r.tow::int) then
      v_lug_ok := public.car_takes_luggage(r.car_id, r.lug::int);
      v_hitch := exists (select 1 from public.cars c where c.id = r.car_id and 'tow_hitch' = any(c.features));
      v_private := exists (select 1 from public.cars c where c.id = r.car_id and c.type = 'temporary');
      -- the towing request that already holds the one hitch (the oldest on the ride): the others are the ones in question
      select q.id into v_holder
      from public.ride_requests rr join public.requests q on q.id = rr.request_id
      where rr.ride_id = v_ride and q.needs_tow_hitch and q.luggage_waived_at is null
        and public._rr_on_leg(r.leg_side, rr.covers_out, rr.covers_return, rr.chain)
      order by rr.created_at, q.id limit 1;
      select array_agg(distinct q.id order by q.id) into v_ids
      from public.ride_requests rr join public.requests q on q.id = rr.request_id
      where rr.ride_id = v_ride and q.luggage_waived_at is null
        and public._rr_on_leg(r.leg_side, rr.covers_out, rr.covers_return, rr.chain)
        and ((q.has_luggage and not v_lug_ok)
             or (q.needs_tow_hitch and not v_private and (not v_hitch or q.id is distinct from v_holder)));
      if v_mode = 'allow' then
        -- the person placing by hand accepted a car without what these requests need (large trunk / hitch)
        update public.requests set luggage_waived_at = now(), luggage_waived_by = (select auth.uid())
        where id = any(v_ids) and luggage_waived_at is null;
      elsif v_mode = 'ask' then
        raise exception 'needs_large_trunk' using errcode = 'P0001', detail = public._small_trunk_detail_for(v_ids, r.car_id, v_ride);
      else
        raise exception 'luggage_capacity_violation' using errcode = 'P0001', detail =
          format('ride %s leg %s carries %s large-luggage and %s towing request(s)', v_ride, r.leg_side, r.lug, r.tow);
      end if;
    end if;
  end loop;
end $$;

-- ====================================================================================================
CREATE OR REPLACE FUNCTION "public"."ride_seats_verdict"("p_ride_id" "uuid", "p_guests" "jsonb") RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  r record;
  v_mode text := coalesce(current_setting('app.small_trunk', true), '');
  v_guest uuid; v_guest_leg public.ride_leg;
begin
  for r in
    with ride as (
      select rd.id, rd.car_id, rd.driver_id from public.rides rd where rd.id = p_ride_id and rd.status <> 'cancelled'
    ),
    seated as (
      -- CM1 phase 2: a chained row seats its own leg only; a guest entry with `chain` replaces the ride's row (a preview)
      select rr.request_id, rr.role::text as role, rr.covers_out, rr.covers_return, rr.chain
      from public.ride_requests rr where rr.ride_id = p_ride_id
        and not exists (select 1 from jsonb_array_elements(coalesce(p_guests, '[]'::jsonb)) e
                         where (e->>'request_id')::uuid = rr.request_id and e ? 'chain')
      union all
      select g.request_id, 'passenger', g.leg in ('out', 'both'), g.leg in ('return', 'both'), g.chain
      from (
        select distinct on ((e->>'request_id')::uuid) (e->>'request_id')::uuid as request_id, coalesce(e->>'leg', 'both') as leg,
               e->>'chain' as chain
        from jsonb_array_elements(coalesce(p_guests, '[]'::jsonb)) e
        order by (e->>'request_id')::uuid
      ) g
      where (g.chain is not null or not exists (select 1 from public.ride_requests x where x.ride_id = p_ride_id and x.request_id = g.request_id))
        and exists (select 1 from public.requests q where q.id = g.request_id)
    )
    select legs.leg_side, ride.car_id,
           sum(q.adults)
             + case when (select coalesce(bool_or(x.role = 'driver'), false) from seated x) or coalesce(bool_or(q.requester_id = ride.driver_id), false) then 0 else 1 end as a,
           case when (select coalesce(bool_or(x.role = 'driver'), false) from seated x) or coalesce(bool_or(q.requester_id = ride.driver_id), false) then 0 else 1 end as bonus,
           sum(q.child_seats) as c, sum(q.boosters) as b,
           count(*) filter (where q.has_luggage and q.luggage_waived_at is null) as lug,
           count(*) filter (where q.needs_tow_hitch and q.luggage_waived_at is null) as tow
    from ride
    cross join (values ('out'), ('return')) as legs(leg_side)
    join seated s on public._rr_on_leg(legs.leg_side, s.covers_out, s.covers_return, s.chain)
    join public.requests q on q.id = s.request_id
    group by legs.leg_side, ride.car_id
    order by legs.leg_side
  loop
    -- REQ item 246 h: as assert_ride_seats_fit - per stretch only when the sum does not fit and someone gets on / off
    -- midway; the proposed guests (and a volunteer driver) = the leg's count less the ride's own rows, on the whole leg.
    -- (A nested if: a subquery in the first test would cost every call the full executor.)
    -- CM1 (REQ item 260 a): one person on two of the ride's requests (or a proposed guest) counts once
    if not public.car_fits(r.car_id, r.a::int, r.c::int, r.b::int)
       and not public._seats_fit_once(r.car_id, p_ride_id, r.leg_side::public.ride_leg, r.a::int, r.c::int, r.b::int, r.bonus::int, p_guests) then
      -- REQ item 246 h (phase 2c): one guest proposed - the seats per stretch on the route with the guest
      select (e->>'request_id')::uuid, coalesce(e->>'leg', 'both')::public.ride_leg into v_guest, v_guest_leg
        from jsonb_array_elements(coalesce(p_guests, '[]'::jsonb)) e
       where not exists (select 1 from public.ride_requests x where x.ride_id = p_ride_id and x.request_id = (e->>'request_id')::uuid)
       limit 1;
      if v_guest is not null and (select count(distinct e->>'request_id') from jsonb_array_elements(p_guests) e
                                  where not exists (select 1 from public.ride_requests x where x.ride_id = p_ride_id
                                                    and x.request_id = (e->>'request_id')::uuid)) = 1 then
        if not public._ride_leg_fits_with_guest(p_ride_id, r.leg_side::public.ride_leg, r.car_id, v_guest, v_guest_leg,
             (select jsonb_build_array(jsonb_build_object('adults', r.a - coalesce(sum(q.adults), 0) - g.adults,
                 'childSeats', r.c - coalesce(sum(q.child_seats), 0) - g.child_seats, 'boosters', r.b - coalesce(sum(q.boosters), 0) - g.boosters))
               from public.requests g
               left join public.ride_requests rr on rr.ride_id = p_ride_id
                 and public._rr_on_leg(r.leg_side, rr.covers_out, rr.covers_return, rr.chain)
               left join public.requests q on q.id = rr.request_id
              where g.id = v_guest group by g.adults, g.child_seats, g.boosters)) then
          return 'seat_config_violation';
        end if;
      elsif not public._ride_has_rider_spans(p_ride_id)
         or not public._ride_leg_fits_along(p_ride_id, r.leg_side::public.ride_leg, r.car_id,
              (select jsonb_build_array(jsonb_build_object('adults', r.a - coalesce(sum(q.adults), 0),
                 'childSeats', r.c - coalesce(sum(q.child_seats), 0), 'boosters', r.b - coalesce(sum(q.boosters), 0)))
               from public.ride_requests rr join public.requests q on q.id = rr.request_id
              where rr.ride_id = p_ride_id
                and public._rr_on_leg(r.leg_side, rr.covers_out, rr.covers_return, rr.chain))) then
        return 'seat_config_violation';
      end if;
    end if;
    if not public.car_meets_needs(r.car_id, r.lug::int, r.tow::int) then
      if v_mode = 'allow' then
        null;   -- the person placing by hand accepted the car; the real write records the waiver
      elsif v_mode = 'ask' then
        return 'needs_large_trunk';
      else
        return 'luggage_capacity_violation';
      end if;
    end if;
  end loop;
  return null;
end;
$$;

-- ====================================================================================================
CREATE OR REPLACE FUNCTION "public"."_ride_people_fit"("p_ride_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_car uuid; v_driver uuid; v_bonus int; l public.ride_leg; v_a int; v_c int; v_b int;
begin
  select r.car_id, r.driver_id into v_car, v_driver from public.rides r where r.id = p_ride_id;
  v_bonus := case when v_driver is not null
    and not exists (select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.role = 'driver') then 1 else 0 end;
  foreach l in array array['out', 'return']::public.ride_leg[] loop
    select coalesce(sum(q.adults), 0), coalesce(sum(q.child_seats), 0), coalesce(sum(q.boosters), 0) into v_a, v_c, v_b
      from public.ride_requests rr join public.requests q on q.id = rr.request_id
     where rr.ride_id = p_ride_id and public._rr_on_leg(l::text, rr.covers_out, rr.covers_return, rr.chain);   -- CM1: a chained trip, its own leg only
    select v_a + count(*) filter (where rp.seat_kind = 'adult'), v_c + count(*) filter (where rp.seat_kind = 'child_seat'),
           v_b + count(*) filter (where rp.seat_kind = 'booster')
      into v_a, v_c, v_b
      from public.ride_passengers rp where rp.ride_id = p_ride_id and (rp.leg = 'both' or rp.leg = l);
    if not public.car_fits(v_car, v_a + v_bonus, v_c, v_b)
       -- CM1 (REQ item 260 a): one person on two of the ride's requests counts once
       and not public._seats_fit_once(v_car, p_ride_id, l, v_a + v_bonus, v_c, v_b, v_bonus)
       and not public._ride_leg_fits_along(p_ride_id, l, v_car, jsonb_build_array(jsonb_build_object('adults', v_bonus)), true) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- ====================================================================================================
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
    'chain', case when v_chain is not null then v_chain || jsonb_build_object('route', v_chain_route) end,
    'starts_at', v_ride.starts_at, 'new_starts_at', v_start,
    'ends_at', v_ride.ends_at, 'new_ends_at', v_end);
end;
$$;

-- ====================================================================================================
CREATE OR REPLACE FUNCTION "public"."_merge_preview_core"("p_ride_id" "uuid", "p_request_id" "uuid", "p_leg" "public"."ride_leg" DEFAULT 'both'::"public"."ride_leg") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_ride public.rides%rowtype; v_req public.requests%rowtype; v jsonb; v_err text; v_jd timestamptz; v_jr timestamptz;
  v_prev text; v_prev_det text; v_lug boolean := false; v_det boolean := false; v_fix boolean := false;
  v_day date; v_wait_end timestamptz; v_wait_start timestamptz; v_swap boolean;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride.id is null then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  -- the caller authorizes (merge_preview: the Sadran; _member_merge_check: the member driving the ride)
  if v_req.department_id <> v_ride.department_id or v_req.week_start <> v_ride.week_start then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  -- REQ §13.111 (a) / §13.175 (a): checked "as if allowed" so every other verdict (seats, turnaround...) is real; a
  -- large-trunk problem or a long detour alone comes back as a *waivable* refusal the Sadran may accept.
  v_prev := coalesce(current_setting('app.small_trunk', true), '');
  v_prev_det := coalesce(current_setting('app.long_detour', true), '');
  perform set_config('app.small_trunk', 'allow', true);
  perform set_config('app.long_detour', 'allow', true);
  v := public._merge_check(p_ride_id, p_request_id, p_leg);
  perform set_config('app.small_trunk', v_prev, true);
  perform set_config('app.long_detour', v_prev_det, true);
  v_err := v ->> 'error';
  v_lug := coalesce((v ->> 'luggage_problem')::boolean, false);
  v_det := coalesce((v ->> 'detour_problem')::boolean, false);
  if jsonb_typeof(v -> 'chain') = 'object' then
    -- CM1 phase 2: a chained trip keeps its own hours (the chain's window is both trips')
    v_jd := v_req.depart_at; v_jr := v_req.return_at;
  else
    select jt.dep, jt.ret into v_jd, v_jr from public._joiner_times(p_ride_id, p_request_id, p_leg) jt;
  end if;
  if v_err is null and coalesce((v ->> 'turnaround_conflict')::boolean, false) then v_err := 'merge_turnaround_conflict'; end if;
  if v_err is null then
    begin
      perform public.assert_private_car_owner_only(v_ride.car_id, (select auth.uid()), v_req.requester_id);
    exception when others then
      if sqlerrm = 'private_car_owner_only' then v_err := sqlerrm; end if;
    end;
  end if;
  if v_err is null and v_lug and v_prev <> 'allow' then v_err := 'merge_luggage_needs_large_trunk'; end if;
  if v_err is null and v_det and v_prev_det <> 'allow' then v_err := 'merge_detour_too_long'; end if;
  -- REQ item 246 g: a stop's stated hour moved - reported only (owner 2026-11-16: a warning, never a refusal)
  v_fix := jsonb_typeof(v -> 'fixed_hour') = 'object';

  -- REQ §13.175 (b): the merged ride reaches the guest at a different time than asked. Besides taking the guest at that
  -- time, the host's ride may stretch to the guest's own time: later on the way back (wait_ends_at - the return leg's
  -- times count back from the ride's end), earlier on the way out (wait_starts_at). Quarter-hour grid, same day only.
  v_day := (v_ride.starts_at at time zone 'Asia/Jerusalem')::date;
  if jsonb_typeof(v -> 'chain') = 'object' then
    null;   -- nothing to wait for
  elsif p_leg in ('return', 'both') and v_jr is not null and v_req.return_at is not null and v_req.return_at > v_jr + interval '5 minutes' then
    v_wait_end := to_timestamp(round(extract(epoch from ((v ->> 'new_ends_at')::timestamptz + (v_req.return_at - v_jr))) / 900) * 900);
    if ((v_wait_end - interval '1 minute') at time zone 'Asia/Jerusalem')::date <> v_day then v_wait_end := null; end if;
  end if;
  -- REQ §13.179 (c): a reversed one-way (R6B5) is picked up on the way back - the ride waits for its time by ending later.
  v_swap := p_leg = 'out' and public._merge_guest_swapped(p_ride_id, p_request_id);
  if v_swap and v_jd is not null and v_req.depart_at is not null and v_req.depart_at > v_jd + interval '5 minutes' then
    v_wait_end := to_timestamp(round(extract(epoch from ((v ->> 'new_ends_at')::timestamptz + (v_req.depart_at - v_jd))) / 900) * 900);
    if ((v_wait_end - interval '1 minute') at time zone 'Asia/Jerusalem')::date <> v_day then v_wait_end := null; end if;
  end if;
  if jsonb_typeof(v -> 'chain') is distinct from 'object' and p_leg in ('out', 'both') and not v_swap and v_jd is not null and v_req.depart_at is not null and v_req.depart_at < v_jd - interval '5 minutes' then
    v_wait_start := to_timestamp(round(extract(epoch from ((v ->> 'new_starts_at')::timestamptz - (v_jd - v_req.depart_at))) / 900) * 900);
    if (v_wait_start at time zone 'Asia/Jerusalem')::date <> v_day then v_wait_start := null; end if;
  end if;

  -- seats / luggage are part of _merge_check (R7B3): one verdict for preview, create, send and apply.
  return v || jsonb_build_object('ok', v_err is null, 'error', v_err, 'code', public._merge_error_code(v_err),
    'waivable', coalesce(v_err in ('merge_luggage_needs_large_trunk', 'merge_detour_too_long', 'merge_fixed_hour'), false),
    'luggage_waivable', coalesce(v_lug and v_err in ('merge_luggage_needs_large_trunk', 'merge_detour_too_long', 'merge_fixed_hour'), false),
    'detour_waivable', coalesce((v_det or v_fix) and v_err in ('merge_luggage_needs_large_trunk', 'merge_detour_too_long', 'merge_fixed_hour'), false),
    'joiner_depart_at', v_jd, 'joiner_return_at', v_jr,
    'joiner_old_depart_at', case when p_leg in ('out', 'both') then v_req.depart_at end,
    'joiner_old_return_at', case when p_leg in ('return', 'both') then v_req.return_at end,
    'wait_ends_at', v_wait_end, 'wait_starts_at', v_wait_start);
end $$;

-- ====================================================================================================
CREATE OR REPLACE FUNCTION "public"."_member_merge_check"("p_ride_id" "uuid", "p_source_ride_id" "uuid", "p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_me uuid := (select auth.uid());
  h public.rides%rowtype; src public.rides%rowtype; q public.requests%rowtype;
  v_out boolean; v_ret boolean; v_leg public.ride_leg; v jsonb;
  v_jd timestamptz; v_jr timestamptz; v_out_ok boolean := true; v_ret_ok boolean := true; v_wait_fix boolean := true;
  v_early int; v_late int; v_src_ok boolean; v_swap boolean; v_others text[]; v_guest text; v_src_driver text;
begin
  select * into h from public.rides where id = p_ride_id;
  select * into src from public.rides where id = p_source_ride_id;
  if h.id is null or src.id is null or h.status = 'cancelled' or src.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if v_me is null or h.driver_id is distinct from v_me or not public.member_of(h.department_id) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if src.department_id <> h.department_id or src.week_start <> h.week_start
     or (src.starts_at at time zone 'Asia/Jerusalem')::date <> (h.starts_at at time zone 'Asia/Jerusalem')::date then
    raise exception 'ride_request_day_mismatch' using errcode = 'P0001';
  end if;
  if not public.is_day_public(h.department_id, h.week_start, (h.starts_at at time zone 'Asia/Jerusalem')::date)
     or exists (select 1 from public.weeks w where w.department_id = h.department_id and w.week_start = h.week_start and w.phase = 'archived') then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if (h.starts_at at time zone 'Asia/Jerusalem')::date < (now() at time zone 'Asia/Jerusalem')::date or (src.starts_at at time zone 'Asia/Jerusalem')::date < (now() at time zone 'Asia/Jerusalem')::date then raise exception 'ride_in_past' using errcode = 'P0001'; end if;   -- ED1
  select * into q from public.requests where id = p_request_id;
  select bool_or(rr.covers_out), bool_or(rr.covers_return) into v_out, v_ret
  from public.ride_requests rr where rr.ride_id = src.id and rr.request_id = p_request_id;
  if q.id is null or v_out is null then raise exception 'request_not_on_ride' using errcode = 'P0001'; end if;
  v_leg := case when v_out and v_ret then 'both' when v_out then 'out' else 'return' end::public.ride_leg;
  -- CM1 phase 2: my own two rides merge only as a chain (one after the other)
  if q.requester_id = v_me and public._merge_chain_plan(p_ride_id, p_request_id, v_leg) is null then
    raise exception 'merge_already_on_ride' using errcode = 'P0001';
  end if;

  v := public._merge_preview_core(p_ride_id, p_request_id, v_leg);
  -- REQ §13.179 (c): a reversed one-way (a pickup from the ride's destination back to its start, R6B5) rides the way
  -- back - reached earlier than asked, the ride waits by ending later; reached later than asked, no stretch helps.
  v_swap := v_leg = 'out' and public._merge_guest_swapped(p_ride_id, p_request_id);

  -- the guest keeps their own time (within their flexibility), with the ride as it is / stretched to the guest's time
  v_jd := (v ->> 'joiner_depart_at')::timestamptz; v_jr := (v ->> 'joiner_return_at')::timestamptz;
  if v_leg in ('out', 'both') and v_jd is not null and q.depart_at is not null then
    v_early := extract(epoch from coalesce(q.flex_depart_early, interval '0')) / 60; v_late := extract(epoch from coalesce(q.flex_depart_late, interval '0')) / 60;
    v_out_ok := extract(epoch from (v_jd - q.depart_at)) / 60 between -v_early and v_late;
    if not v_out_ok and (v_jd < q.depart_at) <> v_swap then v_wait_fix := false; end if;   -- earlier than asked (later, reversed): no stretch helps
    if not v_out_ok and v ->> (case when v_swap then 'wait_ends_at' else 'wait_starts_at' end) is null then v_wait_fix := false; end if;
  end if;
  if v_leg in ('return', 'both') and v_jr is not null and q.return_at is not null then
    v_early := extract(epoch from coalesce(q.flex_return_early, interval '0')) / 60; v_late := extract(epoch from coalesce(q.flex_return_late, interval '0')) / 60;
    v_ret_ok := extract(epoch from (v_jr - q.return_at)) / 60 between -v_early and v_late;
    if not v_ret_ok and v_jr > q.return_at then v_wait_fix := false; end if;
    if not v_ret_ok and v ->> 'wait_ends_at' is null then v_wait_fix := false; end if;
  end if;
  v_src_ok := src.driver_id is null or src.needs_driver or src.driver_id = v_me;
  select coalesce(array_agg(distinct p.full_name order by p.full_name), '{}') into v_others
  from public.ride_requests rr join public.requests oq on oq.id = rr.request_id join public.profiles p on p.id = oq.requester_id
  where rr.ride_id = h.id and oq.requester_id <> v_me and oq.id <> p_request_id;
  select full_name into v_guest from public.profiles where id = q.requester_id;
  select full_name into v_src_driver from public.profiles where id = src.driver_id and src.driver_id <> v_me;

  return v || jsonb_build_object('leg', v_leg, 'guest_name', v_guest,
    'time_kept', v_out_ok and v_ret_ok, 'wait_keeps_time', v_wait_fix and not (v_out_ok and v_ret_ok),
    'direct', v_out_ok and v_ret_ok and v_src_ok and cardinality(v_others) = 0,
    'direct_with_wait', (v_out_ok and v_ret_ok or v_wait_fix) and v_src_ok and cardinality(v_others) = 0,
    'source_driver_name', v_src_driver, 'other_riders', to_jsonb(v_others));
end $$;

-- ====================================================================================================
CREATE OR REPLACE FUNCTION "public"."apply_proposal"("p_proposal_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_prop record;
  v_req record;
  v_ride_id uuid;
  v_leg jsonb;
  v_has_driver_leg boolean;
  v_is_auto_apply boolean;
  v_existing public.rides%rowtype;
  v_old record;
  v_home uuid;
  host public.rides%rowtype;
  required_party uuid;
  combined_start timestamptz;combined_end timestamptz;
  route_before jsonb:='{}'::jsonb;
  v_chain_plans jsonb:='{}'::jsonb;
  v_has_places boolean; route_old int; route_new int; shift_start timestamptz; shift_end timestamptz;
  gap_override smallint;
  v_origin_result jsonb;
  v_leg_txt text; v_merge_out boolean:=false; v_merge_ret boolean:=false; v_snap jsonb; v_served_status public.request_status;
  v_old_dep timestamptz; v_old_ret timestamptz; v_old_car uuid; v_old_series_dep timestamptz; v_old_series_ret timestamptz;
  v_rv_joiner jsonb; v_rvs jsonb:='{}'::jsonb; v_rcpt record; v_byname text; v_tc text:=''; v_variant text; v_vars jsonb;
  v_sib record; v_sprop record;
  v_new_car text; v_old_car_name text; v_change_line text:=''; v_snap_fp text; v_explicit boolean; v_src_fp jsonb; v_cur_host_fp text;
begin
  select * into v_prop from public.proposals where id = p_proposal_id for update;
  if v_prop is null then raise exception 'proposal_not_found' using errcode = 'P0001'; end if;

  v_is_auto_apply := coalesce(current_setting('app.auto_applying_proposal', true), '') = 'on';
  if not v_is_auto_apply and not public.can_manage_week(v_prop.department_id, v_prop.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if v_prop.status <> 'accepted' then raise exception 'proposal_not_accepted' using errcode = 'P0001'; end if;

  select * into v_req from public.requests where id = v_prop.request_id for update;
  select home_destination_id into v_home from public.departments where id=v_prop.department_id;
  perform set_config('app.audit_reason', 'apply_proposal', true);
  perform set_config('app.system_status_transition', 'on', true);
  perform set_config('app.applying_proposal', p_proposal_id::text, true);
  -- REQ §13.111 (a): the Sadran waived the large trunk for this proposal: the placement stamps the waiver (assert_ride_seats_fit).
  if v_prop.created_via = 'sadran' and coalesce((v_prop.payload ->> 'allow_small_trunk')::boolean, false) then
    perform public._small_trunk_mode(true);
  end if;
  -- REQ §13.175 (a): the Sadran accepted a long detour for this merge.
  perform public._long_detour_mode(v_prop.created_via = 'sadran' and coalesce((v_prop.payload ->> 'allow_long_detour')::boolean, false));
  -- Old values for the old -> new notification lines (REQ §13.101 b), taken before anything changes.
  -- R14B5: "old" is what the member holds now - the booked ride's times once a ride carries the request.
  select bt.dep, bt.ret into v_old_dep, v_old_ret from public._request_booked_times(v_req.id) bt;
  select rd.car_id into v_old_car from public.rides rd join public.ride_requests rr on rr.ride_id = rd.id
  where rr.request_id = v_req.id and rd.status <> 'cancelled' order by rd.starts_at limit 1;

  if v_prop.type = 'deny' then
    update public.requests set status = 'denied', status_reason = coalesce(v_prop.payload ->> 'reason', 'DENIED_BY_SADRAN')
    where id = v_prop.request_id;
  elsif v_prop.type = 'external' then
    -- REQ §13.136 g: "manage on your own" for a request that is placed right now (the solver offers it so someone without
    -- a car gets this one) gives the booking up first, as a withdraw does; an unplaced request has nothing to release.
    if exists (select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
               where rr.request_id = v_req.id and rd.status <> 'cancelled') then
      perform public.release_request_booking(v_req.id);
    end if;
    update public.requests set status = 'external', status_reason = coalesce(v_prop.payload ->> 'reason', 'EXTERNAL')
    where id = v_prop.request_id;
    -- REQ §13.105 / QA run 5 R5B6: "no car" for one leg of a multi-day request is "no car" for the whole trip - every other
    -- still-unplaced leg of the series resolves the same way (their own open proposals are withdrawn first), instead of
    -- leaving the siblings on the waiting list next to an external leg.
    if v_req.series_id is not null then
      for v_sib in select q.id from public.requests q
          where q.series_id = v_req.series_id and q.id <> v_req.id
            and q.status in ('submitted', 'waitlisted', 'proposed') order by q.id for update loop
        for v_sprop in select p.id, p.status from public.proposals p
            where p.request_id = v_sib.id and p.status in ('draft', 'sent', 'accepted') order by p.id loop
          if v_sprop.status = 'draft' then update public.proposals set status = 'withdrawn' where id = v_sprop.id;
          else perform public.proposal_system_withdraw(v_sprop.id, 'withdrawn_edit'); end if;
        end loop;
        update public.requests set status = 'external', status_reason = coalesce(v_prop.payload ->> 'reason', 'EXTERNAL')
        where id = v_sib.id;
      end loop;
    end if;
  elsif v_prop.type = 'alternative' then
    -- REQ §13.112 (a): the member accepted their own plan B; the original main trip is kept whole in request_alternatives.
    v_ride_id := public._apply_alternative(v_prop.id);
  elsif v_prop.type = 'origin' then
    update public.requests set
      origin_id = (v_prop.payload ->> 'origin_id')::uuid, origin_text = null,
      preferred_car_id = (v_prop.payload ->> 'car_id')::uuid,
      status = 'submitted'
    where id = v_prop.request_id;
    -- REQ §13.102 R2B16: the new origin is the start, not also a stop of the outbound leg.
    delete from public.request_stops where request_id = v_prop.request_id and leg = 'out'
      and place_id = (v_prop.payload ->> 'origin_id')::uuid;
    v_origin_result := public.try_auto_approve(v_prop.request_id);
    if coalesce(v_origin_result ->> 'status', '') <> 'assigned' then
      raise exception 'origin_change_unavailable' using errcode = 'P0001';
    end if;
    v_ride_id := (v_origin_result ->> 'ride_id')::uuid;
  elsif v_prop.type = 'shift' and v_prop.payload ? 'series_span' then
    -- REQ §13.101 j: fewer days for a multi-day request, held on one car.
    if v_prop.created_via = 'sadran' then
      perform public.assert_private_car_owner_only((v_prop.payload->>'car_id')::uuid, v_prop.created_by, v_req.requester_id);
    end if;
    select min(q.depart_at), max(q.return_at) into v_old_series_dep, v_old_series_ret
    from public.requests q where q.series_id = v_req.series_id and q.status not in ('withdrawn', 'cancelled');
    v_ride_id := public._apply_series_span(v_req.id, v_prop.payload -> 'series_span', (v_prop.payload ->> 'car_id')::uuid);
  elsif v_prop.type = 'shift' then
    v_has_places := v_prop.payload ? 'origin_id' or v_prop.payload ? 'origin_text' or v_prop.payload ? 'destination_id'
      or v_prop.payload ? 'destination_text' or v_prop.payload ? 'stops';
    if v_has_places then
      perform public._assert_shift_places(v_req.id, v_req.department_id, v_prop.payload);
      route_old := (case when v_req.depart_at is not null then coalesce(public.request_leg_route_minutes(v_req.id,'out'),0) else 0 end)
        + (case when v_req.return_at is not null then coalesce(public.request_leg_route_minutes(v_req.id,'return'),0) else 0 end);
      update public.requests set
        origin_id = case when v_prop.payload ? 'origin_id' or v_prop.payload ? 'origin_text' then nullif(v_prop.payload ->> 'origin_id','')::uuid else origin_id end,
        origin_text = case when v_prop.payload ? 'origin_id' or v_prop.payload ? 'origin_text' then nullif(btrim(coalesce(v_prop.payload ->> 'origin_text','')),'') else origin_text end,
        destination_id = case when v_prop.payload ? 'destination_id' or v_prop.payload ? 'destination_text' then nullif(v_prop.payload ->> 'destination_id','')::uuid else destination_id end,
        destination_text = case when v_prop.payload ? 'destination_id' or v_prop.payload ? 'destination_text' then nullif(btrim(coalesce(v_prop.payload ->> 'destination_text','')),'') else destination_text end
      where id = v_req.id;
      if v_prop.payload ? 'stops' then
        perform public.replace_request_stops(v_req.id, v_req.department_id,
          coalesce(nullif(v_prop.payload ->> 'return_at','')::timestamptz, v_req.return_at) is not null, v_prop.payload -> 'stops');
      end if;
      select * into v_req from public.requests where id = v_prop.request_id;
      route_new := (case when v_req.depart_at is not null then coalesce(public.request_leg_route_minutes(v_req.id,'out'),0) else 0 end)
        + (case when v_req.return_at is not null then coalesce(public.request_leg_route_minutes(v_req.id,'return'),0) else 0 end);
    end if;
    if v_prop.payload ? 'car_id' and v_req.trip_type is distinct from 'round_trip' then
      -- REQ §13.94: one_way / drop_off place on the named car by trip type (_shift_place_on_car).
      v_ride_id := public._shift_place_on_car(v_prop.id);
    elsif v_prop.payload ? 'car_id' then
      select rd.* into v_existing from public.rides rd join public.ride_requests rr on rr.ride_id=rd.id
      where rr.request_id=v_req.id and rr.role='driver' and rd.status<>'cancelled' order by rd.starts_at limit 1 for update of rd;
      perform public.assert_private_car_owner_only((v_prop.payload->>'car_id')::uuid, v_prop.created_by, v_req.requester_id);
      shift_start := coalesce((v_prop.payload->>'depart_at')::timestamptz, v_existing.starts_at, v_req.depart_at);
      shift_end := coalesce((v_prop.payload->>'return_at')::timestamptz, v_existing.ends_at, v_req.return_at);
      if v_has_places and not (v_prop.payload ? 'return_at') and v_existing.id is not null and coalesce(route_new,0) > coalesce(route_old,0) then
        shift_end := public._round_up_ride_end(shift_start, shift_end + make_interval(mins => route_new - route_old));
      end if;
      if v_prop.created_via='sadran' then
        gap_override:=public.prepare_manual_ride_window((v_prop.payload->>'car_id')::uuid,v_prop.week_start,shift_start,shift_end,v_existing.id);
      end if;
      if v_existing.id is not null then
        if v_prop.created_via<>'sadran' and exists(select 1 from public.ride_requests rr where rr.ride_id=v_existing.id and rr.request_id<>v_req.id) then raise exception 'shared_ride_requires_sadran'; end if;
        update public.rides set turnaround_override_minutes=gap_override,car_id=(v_prop.payload->>'car_id')::uuid,
          starts_at=shift_start,
          ends_at=shift_end,
          is_pinned=true,pin_reason='PROPOSAL_APPLIED' where id=v_existing.id returning id into v_ride_id;
      else
        insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by,turnaround_override_minutes)
        values(v_prop.department_id,v_prop.week_start,(v_prop.payload->>'car_id')::uuid,
          shift_start,shift_end,
          coalesce((v_prop.payload->>'origin_id')::uuid,v_req.origin_id,v_home),coalesce((v_prop.payload->>'destination_id')::uuid,v_req.origin_id,v_home),v_req.requester_id,
          case when public.is_week_public(v_prop.department_id,v_prop.week_start) then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
          true,'PROPOSAL_APPLIED',v_prop.created_by,gap_override) returning id into v_ride_id;
        insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(v_ride_id,v_req.id,'driver','both','keep');
      end if;
      update public.requests set status='assigned',status_reason='PROPOSAL_APPLIED' where id=v_req.id;
      perform public.assert_ride_request_day(v_ride_id);
      perform public.assert_ride_seats_fit(v_ride_id);
      perform public.assert_car_chain((v_prop.payload->>'car_id')::uuid,v_prop.week_start);
      if v_existing.car_id is not null and v_existing.car_id<>(v_prop.payload->>'car_id')::uuid then perform public.assert_car_chain(v_existing.car_id,v_prop.week_start); end if;
    elsif not (v_prop.payload ? 'depart_at' or v_prop.payload ? 'return_at' or v_prop.payload ? 'trip_shape'
               or v_prop.payload ? 'needs_car_at_destination')
          and exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id
                     where rr.request_id=v_req.id and r.status<>'cancelled') then
      -- REQ §13.100 QB22: an edit-route shift of a request that live rides still serve changes the route only.
      select case when exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id
                              where rr.request_id=v_req.id and r.status<>'cancelled' and r.needs_driver) then 'waitlisted'
                  when exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id
                              where rr.request_id=v_req.id and r.status<>'cancelled' and rr.role='driver') then 'assigned'
                  else 'merged' end::public.request_status into v_served_status;
      update public.requests set status=v_served_status,
        status_reason=case when v_served_status='waitlisted' then 'UNMET_NEEDS_DRIVER' else 'PROPOSAL_APPLIED' end
      where id=v_req.id;
    else
      update public.requests set
        depart_at = coalesce((v_prop.payload ->> 'depart_at')::timestamptz, depart_at),
        return_at = coalesce((v_prop.payload ->> 'return_at')::timestamptz, return_at),
        trip_shape = coalesce((v_prop.payload ->> 'trip_shape')::public.trip_shape, trip_shape),
        needs_car_at_destination = coalesce((v_prop.payload ->> 'needs_car_at_destination')::boolean, needs_car_at_destination),
        status = 'submitted', status_reason = 'PROPOSAL_APPLIED_PENDING_ASSIGNMENT'
      where id = v_prop.request_id;
    end if;
  elsif v_prop.type = 'merge' then
    -- REQ §13.101 b: everyone already on the ride is told every time someone joins; their old -> new lines are
    -- read now, before the ride moves.
    v_rv_joiner := public.proposal_reader_vars(v_prop.id, v_req.requester_id);
    select coalesce(jsonb_object_agg(y.pid::text, public.proposal_reader_vars(v_prop.id, y.pid)), '{}'::jsonb) into v_rvs
    from (select distinct x.pid from (
            select rd.driver_id as pid from public.rides rd
            where rd.id in (select (l->>'ride_id')::uuid from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) l)
            union
            select q.requester_id from public.ride_requests rr join public.requests q on q.id = rr.request_id
            where rr.ride_id in (select (l->>'ride_id')::uuid from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) l)
          ) x where x.pid is not null and x.pid <> v_req.requester_id) y;
    if not exists(select 1 from public.proposal_parties where proposal_id=v_prop.id and profile_id=v_req.requester_id and response='accepted')
      or exists(select 1 from public.proposal_parties where proposal_id=v_prop.id and response<>'accepted') then raise exception 'proposal_consent_required'; end if;
    v_explicit := coalesce((v_prop.payload->>'window_explicit')::boolean,false);
    if v_prop.payload ? 'request_fingerprint' and v_prop.payload->>'request_fingerprint' is distinct from public.merge_request_fingerprint(v_req.id) then perform public.raise_stale_version(); end if;
    for host in select * from public.rides where id in(select (value->>'ride_id')::uuid from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]'))) order by id for update loop
      if host.department_id<>v_prop.department_id or host.week_start<>v_prop.week_start or host.status='cancelled' then raise exception 'ride_not_found'; end if;
      -- REQ §13.99: a private car takes passengers only through its owner (ask-to-join to the owner, or the owner's own act).
      if v_prop.created_via<>'ask_to_join' then
        perform public.assert_private_car_owner_only(host.car_id, v_prop.created_by, v_req.requester_id);
      end if;
      -- REQ §13.100 QB9: another passenger merging in moves the version; what must still hold is that the host is otherwise unchanged (ride_merge_fingerprint).
      v_snap:=v_prop.payload->'host_snapshots'->host.id::text;
      if v_snap is not null then
        -- REQ §13.102 R2B1: publication flips a draft ride to confirmed (and bumps its version); that alone never
        -- makes an answered proposal stale, so the stored fingerprint is also matched with the draft/confirmed status.
        -- REQ §13.103 R3B1: the fingerprint ignores who drives (a volunteer assigned meanwhile changes nothing the
        -- answer depended on); feasibility is re-validated below (_merge_check, seats, chain).
        if not public._ride_fp_matches(host.id, v_snap->>'fp') then
          perform public.raise_stale_version();
        end if;
      elsif v_prop.payload ? 'host_versions' and host.version is distinct from (v_prop.payload->'host_versions'->>host.id::text)::int then perform public.raise_stale_version(); end if;
      -- consent: the driver and every passenger who was a party; a passenger who joined after the offer needs none
      for required_party in select host.driver_id where host.driver_id is not null union select q.requester_id from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=host.id loop
        if exists(select 1 from public.proposal_parties where proposal_id=v_prop.id and profile_id=required_party)
           and not exists(select 1 from public.proposal_parties where proposal_id=v_prop.id and profile_id=required_party and response='accepted') then raise exception 'proposal_consent_required'; end if;
      end loop;
    end loop;
    v_src_fp := coalesce(v_prop.payload->'source_snapshots','{}'::jsonb);
    if exists(select 1 from jsonb_each_text(coalesce(v_prop.payload->'source_versions','{}')) expected left join public.rides r on r.id=expected.key::uuid
      where r.id is null or r.status='cancelled'
         or (r.version is distinct from expected.value::int
             and (not (v_src_fp ? expected.key)
                  or not public._ride_fp_matches(r.id, v_src_fp->expected.key->>'fp')))) then perform public.raise_stale_version(); end if;
    -- CM1 phase 2: a chain's plan (its driver) is read while the guest is still on its own ride
    for host in select * from public.rides where id in(select (value->>'ride_id')::uuid from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) where coalesce(value->>'leg','both')='both') order by id loop
      v_chain_plans:=v_chain_plans||jsonb_build_object(host.id::text,public._merge_chain_plan(host.id,v_req.id,'both'));
    end loop;
    -- Replace the request's prior solo assignment; do not leave a duplicate driver leg.
    select coalesce(bool_or(coalesce(l->>'leg','both') in ('out','both')),false), coalesce(bool_or(coalesce(l->>'leg','both') in ('return','both')),false)
      into v_merge_out, v_merge_ret from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) l;
    for v_old in select rd.* from public.rides rd join public.ride_requests rr on rr.ride_id=rd.id
      where rr.request_id=v_req.id and rd.status<>'cancelled' and not exists(
        select 1 from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) desired_leg(value) where (desired_leg.value->>'ride_id')::uuid=rd.id
      ) and exists(select 1 from public.ride_requests rr2 where rr2.ride_id=rd.id and rr2.request_id=v_req.id
                   and ((rr2.covers_out and v_merge_out) or (rr2.covers_return and v_merge_ret)))   -- QB2: only the replaced leg's booking
      order by rd.id for update of rd loop
      if v_old.driver_id=v_req.requester_id or (v_old.needs_driver and not exists(select 1 from public.ride_requests where ride_id=v_old.id and request_id<>v_req.id)) then
        if exists(select 1 from public.ride_requests where ride_id=v_old.id and request_id<>v_req.id) or v_old.origin_id<>v_old.destination_id then raise exception 'shared_ride_requires_sadran'; end if;
        update public.rides set status='cancelled',cancelled_at=now(),cancelled_by=v_req.requester_id,cancel_reason='MERGED_BY_CONSENT' where id=v_old.id;
      end if;
      delete from public.ride_requests where ride_id=v_old.id and request_id=v_req.id;
      perform public.assert_car_chain(v_old.car_id,v_old.week_start);
    end loop;
    -- REQ §13.95 H1: validity + added driving of every host before the guest boards.
    for host in select * from public.rides where id in(select (value->>'ride_id')::uuid from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]'))) order by id loop
      select case when count(distinct coalesce(l->>'leg','both'))>1 or bool_or(coalesce(l->>'leg','both')='both') then 'both'
                  else max(coalesce(l->>'leg','both')) end into v_leg_txt
      from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) l where (l->>'ride_id')::uuid=host.id and coalesce(l->>'role','passenger')<>'driver';
      if v_leg_txt is not null then
        route_before:=route_before||jsonb_build_object(host.id::text,public._merge_check(host.id,v_req.id,v_leg_txt::public.ride_leg));
        if not ((route_before->host.id::text->>'ok')::boolean) then raise exception '%',route_before->host.id::text->>'error' using errcode='P0001'; end if;
        -- REQ §13.102 R2B2: the window is always the ride's current one plus the route extension; if that would eat the
        -- car's turnaround the merge is refused with a clear error (only an explicit consented window may be tight).
        if coalesce((route_before->host.id::text->>'turnaround_conflict')::boolean,false)
           and not (v_explicit and coalesce((v_prop.payload->>'allow_tight_turnaround')::boolean,false)) then
          raise exception 'merge_turnaround_conflict' using errcode='P0001';
        end if;
      end if;
    end loop;
    v_has_driver_leg := false;
    for v_leg in select * from jsonb_array_elements(coalesce(v_prop.payload -> 'legs', '[]')) loop
      v_ride_id := (v_leg ->> 'ride_id')::uuid;
      insert into public.ride_requests (ride_id, request_id, role, leg, car_mode, detour_minutes)
      values (v_ride_id, v_prop.request_id, coalesce((v_leg ->> 'role')::public.ride_role, 'passenger'),
        coalesce((v_leg ->> 'leg')::public.ride_leg, 'both'), (v_leg ->> 'car_mode')::public.leg_car_mode,
        coalesce((v_prop.payload ->> 'detour_minutes')::smallint, 0))
      on conflict (ride_id, request_id, leg) do update set car_mode = excluded.car_mode;
      update public.rides set is_pinned = true, pin_reason = 'PROPOSAL_APPLIED' where id = v_ride_id;
      if (v_leg ->> 'role') = 'driver' then
        v_has_driver_leg := true;
      end if;
    end loop;
    -- CM1 phase 2: a chained merge writes its chain (the short trip's row, the driver, the long trip as the route base)
    for host in select * from public.rides where id in(select (value->>'ride_id')::uuid from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]'))) order by id loop
      if jsonb_typeof(route_before->host.id::text->'chain')='object' then
        perform public._apply_chain(host.id,(route_before->host.id::text->'chain')-'route'
          ||jsonb_build_object('driver_id',coalesce(v_chain_plans->host.id::text->>'driver_id',route_before->host.id::text->'chain'->>'driver_id')));
      end if;
    end loop;
    for host in select * from public.rides where id in(select (value->>'ride_id')::uuid from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]'))) order by id for update loop
      -- A legacy payload window (`starts_at`/`ends_at`, the consented expanded merge) still widens the host;
      -- the route extension (start earlier / end later, REQ §13.95) is applied on top of it.
      combined_start:=least(host.starts_at,case when v_explicit then coalesce((v_prop.payload->>'starts_at')::timestamptz,host.starts_at) else host.starts_at end);
      combined_end:=greatest(host.ends_at,case when v_explicit then coalesce((v_prop.payload->>'ends_at')::timestamptz,host.ends_at) else host.ends_at end);
      if route_before ? host.id::text then
        combined_start:=least(combined_start,(route_before->host.id::text->>'new_starts_at')::timestamptz);
        combined_end:=greatest(combined_end,(route_before->host.id::text->>'new_ends_at')::timestamptz);
      end if;
      if combined_end>host.ends_at or combined_start<host.starts_at then
        gap_override:=host.turnaround_override_minutes;
        if v_prop.created_via='sadran' and v_explicit and coalesce((v_prop.payload->>'allow_tight_turnaround')::boolean,false) then
          gap_override:=public.prepare_manual_ride_window(host.car_id,host.week_start,combined_start,combined_end,host.id);
        end if;
        update public.rides set starts_at=combined_start,ends_at=combined_end,turnaround_override_minutes=gap_override where id=host.id;
      end if;
      perform public.assert_ride_request_day(host.id);
      perform public.assert_ride_seats_fit(host.id);
      perform public.assert_car_chain(host.car_id,host.week_start);
    end loop;
    update public.requests set status = (case when exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=v_req.id and r.needs_driver and r.status<>'cancelled') then 'waitlisted' when v_has_driver_leg then 'assigned' else 'merged' end)::public.request_status,
      status_reason = case when exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=v_req.id and r.needs_driver and r.status<>'cancelled') then 'UNMET_NEEDS_DRIVER' else 'PROPOSAL_APPLIED' end
    where id = v_prop.request_id;
  end if;

  perform set_config('app.system_status_transition', 'off', true);
  perform set_config('app.applying_proposal', '', true);

  update public.proposals set status = 'applied', applied_at = now(), applied_ride_id = v_ride_id where id = p_proposal_id;

  select full_name into v_byname from public.profiles where id = v_prop.created_by;
  if v_prop.type = 'merge' then
    -- The joiner: where they ride now, with whom, at what time.
    perform public.enqueue_notification(v_req.requester_id, 'outcome_changed', v_prop.department_id, v_prop.week_start,
      coalesce(v_rv_joiner->'vars', '{}'::jsonb),
      jsonb_build_object('request_id', v_prop.request_id, 'variant',
        case v_rv_joiner->>'variant' when 'merge_passenger_split' then 'merged_split'
          when 'merge_passenger_no_driver' then 'merged_no_driver' else 'merged' end),
      format('outcome_changed:%s:%s', v_prop.request_id, p_proposal_id));
    -- Everyone else on the ride(s): who joined, and only what changes for them.
    for v_rcpt in select key as pid, value as rv from jsonb_each(v_rvs) loop
      perform public.enqueue_notification(v_rcpt.pid::uuid, 'outcome_changed', v_prop.department_id, v_prop.week_start,
        (v_rcpt.rv->'vars'),
        jsonb_build_object('ride_id', v_ride_id, 'variant', 'joined_ride'),
        format('merge_applied:%s:%s', v_prop.id, v_rcpt.pid));
    end loop;
  else
    v_variant := null; v_vars := '{}'::jsonb;
    if v_prop.type = 'external' then
      -- REQ §13.102 R2M5: accepting "arrange it yourself" has its own notice, not the generic "your siddur changed".
      v_variant := 'external_accepted';
      v_vars := jsonb_build_object('route', coalesce(public.request_route_label(v_req.id), ''),
        'day', public.day_date_label(coalesce(v_old_dep, v_old_ret)));
    end if;
    if v_prop.type = 'deny' then
      -- R20B16 (owner 2026-11-14): accepting "no car" has its own notice, like "arrange it yourself".
      v_variant := 'deny_accepted';
      v_vars := jsonb_build_object('route', coalesce(public.request_route_label(v_req.id), ''),
        'day', public.day_date_label(coalesce(v_old_dep, v_old_ret)));
    end if;
    if v_prop.type = 'alternative' then
      v_variant := 'alternative_applied';
      v_vars := jsonb_build_object('route', coalesce(public.request_route_label(v_req.id), ''),
        'day', public.day_date_label(coalesce(v_old_dep, v_old_ret))) || public._alternative_vars(v_prop.payload, v_prop.department_id);
    end if;
    if v_prop.type = 'shift' then
      select c.name into v_new_car from public.cars c where c.id = nullif(v_prop.payload->>'car_id', '')::uuid;
      select c.name into v_old_car_name from public.cars c where c.id = v_old_car;
      if v_prop.payload ? 'series_span' then
        v_tc := public._time_change_line(v_old_series_dep, v_old_series_ret,
          (v_prop.payload->'series_span'->>'depart_at')::timestamptz, (v_prop.payload->'series_span'->>'return_at')::timestamptz, true);
      else
        v_tc := public._time_change_line(v_old_dep, v_old_ret,
          nullif(v_prop.payload->>'depart_at', '')::timestamptz, nullif(v_prop.payload->>'return_at', '')::timestamptz);
      end if;
      if v_old_car is not null and v_new_car is not null and v_old_car is distinct from nullif(v_prop.payload->>'car_id', '')::uuid then
        v_change_line := public._frag('change.car', jsonb_build_object('newCar', v_new_car, 'oldCar', v_old_car_name));
      end if;
      if v_tc <> '' then
        v_variant := 'time_changed';
        v_vars := jsonb_build_object('byName', coalesce(v_byname, ''), 'route', coalesce(public.request_route_label(v_req.id), ''),
          'day', public.day_date_label(coalesce(v_old_dep, v_old_ret)), 'timeChange', v_tc,
          'carLine', case when coalesce(v_new_car, '') <> '' then ' · ' || v_new_car else '' end);
      elsif v_change_line <> '' then
        v_variant := 'car_changed';
        v_vars := jsonb_build_object('route', coalesce(public.request_route_label(v_req.id), ''),
          'day', public.day_date_label(coalesce(v_old_dep, v_old_ret)), 'changeLine', v_change_line);
      end if;
    end if;
    perform public.enqueue_notification(v_req.requester_id, 'outcome_changed', v_prop.department_id, v_prop.week_start,
      v_vars, jsonb_build_object('request_id', v_prop.request_id) || case when v_variant is null then '{}'::jsonb else jsonb_build_object('variant', v_variant) end,
      format('outcome_changed:%s:%s', v_prop.request_id, p_proposal_id));
  end if;
  return v_ride_id;
end;
$$;

-- ====================================================================================================
CREATE OR REPLACE FUNCTION "public"."member_merge_ride"("p_ride_id" "uuid", "p_source_ride_id" "uuid", "p_request_id" "uuid", "p_expected_version" integer, "p_wait" boolean DEFAULT false, "p_allow_long_detour" boolean DEFAULT false, "p_agreed" boolean DEFAULT false, "p_allow_small_trunk" boolean DEFAULT false) RETURNS "jsonb"
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
  update public.requests set status = 'merged', status_reason = 'MEMBER_MERGED' where id = p_request_id;
  perform set_config('app.system_status_transition', v_prev, true);

  for r in select key::uuid as request_id, value as before from jsonb_each(v_before) loop
    perform public._notify_ride_edited(r.request_id, r.before);
  end loop;
  select * into h from public.rides where id = p_ride_id;
  return jsonb_build_object('ride_id', h.id, 'starts_at', h.starts_at, 'ends_at', h.ends_at, 'leg', v_leg);
end $$;

-- ====================================================================================================
CREATE OR REPLACE FUNCTION "public"."_unmerge_core"("p_ride_id" "uuid", "p_request_id" "uuid", "p_reason" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ride public.rides%rowtype;
  v_guest public.requests%rowtype;
  v_base uuid; v_base_return timestamptz; v_base_depart timestamptz;
  v_before int; v_after int; v_delta int; v_b_out int; v_a_out int; v_b_ret int; v_a_ret int;
  v_start timestamptz; v_end timestamptz; v_prev_sys text; v_new_window boolean;
  v_chain text;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  select * into v_guest from public.requests q where q.id = p_request_id;
  if v_guest.id is null or v_guest.department_id <> v_ride.department_id
     or not exists (select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.request_id = p_request_id) then
    raise exception 'request_not_on_ride' using errcode = 'P0001';
  end if;

  select rr.request_id into v_base from public.ride_requests rr where rr.ride_id = p_ride_id
  order by (rr.role = 'driver') desc, rr.created_at, rr.request_id limit 1;
  -- CM1 phase 2: a chained trip comes out even when its person drives (the base trip stays, with its driver)
  select max(rr.chain) into v_chain from public.ride_requests rr where rr.ride_id = p_ride_id and rr.request_id = p_request_id;
  if v_chain is null and (v_base = p_request_id
     or exists (select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.request_id = p_request_id and rr.role = 'driver')
     or v_ride.driver_id is not distinct from v_guest.requester_id) then
    raise exception 'unmerge_base_request' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'unmerge_request', true);
  v_b_out := public.ride_route_minutes(p_ride_id, 'out'); v_b_ret := public.ride_route_minutes(p_ride_id, 'return');
  v_before := public.ride_route_minutes(p_ride_id, 'both');
  delete from public.ride_requests where ride_id = p_ride_id and request_id = p_request_id;
  v_a_out := public.ride_route_minutes(p_ride_id, 'out'); v_a_ret := public.ride_route_minutes(p_ride_id, 'return');
  v_after := public.ride_route_minutes(p_ride_id, 'both');
  v_delta := greatest(coalesce(v_before, 0) - coalesce(v_after, 0), 0);

  select case when rr2.covers_return then q.return_at end, case when rr2.covers_out then q.depart_at end
    into v_base_return, v_base_depart
  from public.ride_requests rr2 join public.requests q on q.id = rr2.request_id
  where rr2.ride_id = p_ride_id and rr2.request_id = v_base limit 1;

  v_start := v_ride.starts_at; v_end := v_ride.ends_at;
  v_new_window := v_base_depart is not null and v_ride.starts_at < v_base_depart;
  if v_chain is not null then
    -- the base trip's own hours again: it left later (the chained trip rode first) / was back earlier (it rode last)
    if v_chain like 'before%' and v_base_depart is not null then v_start := greatest(v_ride.starts_at, v_base_depart); end if;
    if v_chain like 'after%' and v_base_return is not null then v_end := least(v_ride.ends_at, public._round_up_ride_end(v_start, v_base_return)); end if;
    v_new_window := false; v_delta := 0;
  elsif v_new_window then
    if greatest(coalesce(v_b_out, 0) - coalesce(v_a_out, 0), 0) > 0 then
      v_start := least(v_ride.starts_at + make_interval(mins => (ceil(greatest(v_b_out - v_a_out, 0) / 15.0) * 15)::int), v_base_depart);
    end if;
    v_delta := greatest(coalesce(v_b_ret, 0) - coalesce(v_a_ret, 0), 0);
  end if;
  if v_delta > 0 then
    -- 23:59 is the capped "end of day": treat it as 24:00 so the quarter-hour arithmetic inverts apply.
    if (v_end at time zone 'Asia/Jerusalem')::time = time '23:59' then v_end := v_end + interval '1 minute'; end if;
    v_end := v_end - make_interval(mins => (ceil(v_delta / 15.0) * 15)::int);
    v_end := greatest(v_end, coalesce(v_base_return, v_end), v_start + interval '15 minutes');
    v_end := least(public._round_up_ride_end(v_start, v_end), v_ride.ends_at);
  end if;

  update public.rides set starts_at = v_start, ends_at = v_end, updated_at = now() where id = p_ride_id;
  perform public.refresh_car_turnarounds(v_ride.car_id, v_ride.week_start);

  if not exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                 where rr.request_id = p_request_id and r.status <> 'cancelled') then
    v_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'submitted', status_reason = p_reason where id = p_request_id;
    perform set_config('app.system_status_transition', v_prev_sys, true);
  end if;

end;
$$;
