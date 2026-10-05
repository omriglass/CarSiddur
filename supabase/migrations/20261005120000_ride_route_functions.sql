-- REQ §13.94 (BOARD_DRAFTS_PLAN §2) "Merging makes one ride": the route of a ride.
--   _ride_route(ride)         internal, closed (service/definer callers: apply_proposal, unmerge_request)
--   ride_route(ride)          browser-facing table form (authenticated; same visibility as `rides_select`)
--   ride_route_json(ride)     jsonb array for `v_board_rides.route` (next migration)
--   ride_route_minutes(ride, leg)  internal: driving + stop minutes of the route per leg
--   _round_up_ride_end(start, end) internal: quarter-hour ceiling, capped at 23:59 of the start's day
-- The base request is the ride's driver request (else its first served request); its route is the
-- request's own origin -> stops -> destination (`request_leg_route_points`) for each leg the ride
-- covers for it. Every other served request adds its boarding place (its origin on the out leg, its
-- destination on the return leg; skipped when that place is already on the route) and its alighting
-- place (the opposite end) by cheapest insertion over `place_travel` (boarding before alighting; a
-- both-ways passenger is inserted on both legs, mirrored on the return). Free-text places never
-- match and use the default 30-minute hop. ETAs: the out leg runs forward from the ride's start,
-- the return leg backward from the ride's end, `stop_minutes` dwell at every intermediate stop.
-- A reservation (no served request) is just the ride's own origin -> destination.

create or replace function public._route_hop_minutes(p_from uuid, p_to uuid)
returns int
language sql stable security definer set search_path = public, pg_temp
as $$
  select case when p_from is null or p_to is null then 30
    else greatest(coalesce((select travel_minutes from public.place_travel(p_from, p_to)), 30), 0) end;
$$;
revoke all on function public._route_hop_minutes(uuid, uuid) from public;
grant execute on function public._route_hop_minutes(uuid, uuid) to service_role;

-- Adds one place to a working route (jsonb array of {place_id, place_text, request_id, kind}).
-- p_after = 1-based index the place must come after (0 = anywhere after the origin). Returns the
-- place's 1-based index and the new route. An existing place with the same id counts as already
-- on the route (not duplicated) when it lies after p_after.
create or replace function public._route_add_place(p_route jsonb, p_place_id uuid, p_place_text text,
  p_request uuid, p_kind text, p_after int, out o_idx int, out o_route jsonb)
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
    for i in greatest(p_after, 0) + 1 .. n loop
      if nullif(p_route -> (i - 1) ->> 'place_id', '')::uuid = p_place_id then
        o_idx := i; o_route := p_route; return;
      end if;
    end loop;
  end if;
  for k in greatest(p_after + 1, 2) .. n + 1 loop
    prev_id := nullif(p_route -> (k - 2) ->> 'place_id', '')::uuid;
    if k <= n then
      next_id := nullif(p_route -> (k - 1) ->> 'place_id', '')::uuid;
      cost := public._route_hop_minutes(prev_id, p_place_id) + public._route_hop_minutes(p_place_id, next_id)
            - public._route_hop_minutes(prev_id, next_id);
    else
      cost := public._route_hop_minutes(prev_id, p_place_id);
    end if;
    if best_cost is null or cost < best_cost then best_cost := cost; best_k := k; end if;
  end loop;
  if best_k > n then o_route := p_route || jsonb_build_array(elem);
  else o_route := jsonb_insert(p_route, array[(best_k - 1)::text], elem);
  end if;
  o_idx := best_k;
end;
$$;
revoke all on function public._route_add_place(jsonb, uuid, text, uuid, text, int) from public;
grant execute on function public._route_add_place(jsonb, uuid, text, uuid, text, int) to service_role;

create or replace function public._ride_route(p_ride_id uuid)
returns table(leg public.ride_leg, "position" int, place_id uuid, place_text text, request_id uuid, kind text, eta timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_ride public.rides%rowtype;
  v_base uuid; v_out boolean; v_ret boolean;
  v_stop_min int;
  v_leg text;
  v_route jsonb; v_pts record; g record;
  v_board int; v_alight int; v_tmp record;
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
    leg := 'out'; "position" := 0; place_id := v_ride.origin_id; place_text := null; request_id := null; kind := 'origin'; eta := v_ride.starts_at;
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

    for g in
      select q.id, q.origin_id, q.origin_text, q.destination_id, q.destination_text,
             bool_or(rr.covers_out) as c_out, bool_or(rr.covers_return) as c_ret, min(rr.created_at) as first_at
      from public.ride_requests rr join public.requests q on q.id = rr.request_id
      where rr.ride_id = p_ride_id and rr.request_id <> v_base
      group by q.id, q.origin_id, q.origin_text, q.destination_id, q.destination_text
      order by min(rr.created_at), q.id
    loop
      v_covers := case when v_leg = 'out' then g.c_out else g.c_ret end;
      if not v_covers then continue; end if;
      if v_leg = 'out' then
        v_b_id := g.origin_id; v_b_text := g.origin_text; v_a_id := g.destination_id; v_a_text := g.destination_text;
      else
        v_b_id := g.destination_id; v_b_text := g.destination_text; v_a_id := g.origin_id; v_a_text := g.origin_text;
      end if;
      select * into v_tmp from public._route_add_place(v_route, v_b_id, v_b_text, g.id, 'board', 0);
      v_route := v_tmp.o_route; v_board := v_tmp.o_idx;
      select * into v_tmp from public._route_add_place(v_route, v_a_id, v_a_text, g.id, 'alight', v_board);
      v_route := v_tmp.o_route; v_alight := v_tmp.o_idx;
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
        request_id := nullif(v_e ->> 'request_id', '')::uuid; kind := v_e ->> 'kind'; eta := v_t;
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
        request_id := nullif(v_e ->> 'request_id', '')::uuid; kind := v_e ->> 'kind'; eta := v_t;
        return next;
        v_prev_id := v_cur_id;
      end loop;
    end if;
  end loop;
end;
$$;
revoke all on function public._ride_route(uuid) from public;
grant execute on function public._ride_route(uuid) to service_role;

create or replace function public._ride_route_visible(p_ride_id uuid)
returns boolean
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_ride public.rides%rowtype;
begin
  select * into v_ride from public.rides r where r.id = p_ride_id;
  if v_ride.id is null then return false; end if;
  -- service / cron callers carry no user id; same predicate as policy `rides_select` otherwise
  if (select auth.uid()) is null then return true; end if;
  return public.can_manage_week(v_ride.department_id, v_ride.week_start)
    or (public.is_approved() and v_ride.status <> 'draft'
        and public.is_day_public(v_ride.department_id, v_ride.week_start, (v_ride.starts_at at time zone 'Asia/Jerusalem')::date));
end;
$$;
revoke all on function public._ride_route_visible(uuid) from public;
grant execute on function public._ride_route_visible(uuid) to service_role;

create or replace function public.ride_route(p_ride_id uuid)
returns table(leg public.ride_leg, "position" int, place_id uuid, place_text text, request_id uuid, kind text, eta timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from public.rides r where r.id = p_ride_id) then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if not public._ride_route_visible(p_ride_id) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  return query select * from public._ride_route(p_ride_id);
end;
$$;
revoke all on function public.ride_route(uuid) from public;
grant execute on function public.ride_route(uuid) to authenticated, service_role;

create or replace function public.ride_route_json(p_ride_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select case when public._ride_route_visible(p_ride_id) then
    coalesce((select jsonb_agg(jsonb_build_object('leg', r.leg, 'position', r."position", 'place_id', r.place_id,
        'place_text', r.place_text, 'name', d.name, 'request_id', r.request_id, 'kind', r.kind, 'eta', r.eta)
        order by r.leg::text, r."position")
      from public._ride_route(p_ride_id) r left join public.destinations d on d.id = r.place_id), '[]'::jsonb)
    else '[]'::jsonb end;
$$;
revoke all on function public.ride_route_json(uuid) from public;
grant execute on function public.ride_route_json(uuid) to authenticated, service_role;

create or replace function public.ride_route_minutes(p_ride_id uuid, p_leg public.ride_leg default 'both')
returns int
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(sum(m), 0)::int from (
    select round(extract(epoch from (max(r.eta) - min(r.eta))) / 60) as m
    from public._ride_route(p_ride_id) r
    where p_leg = 'both' or r.leg = p_leg
    group by r.leg) x;
$$;
revoke all on function public.ride_route_minutes(uuid, public.ride_leg) from public;
grant execute on function public.ride_route_minutes(uuid, public.ride_leg) to service_role;

create or replace function public._round_up_ride_end(p_start timestamptz, p_end timestamptz)
returns timestamptz
language plpgsql stable set search_path = public, pg_temp
as $$
declare v_end timestamptz := to_timestamp(ceil(extract(epoch from p_end) / 900) * 900);
begin
  if (v_end at time zone 'Asia/Jerusalem')::date <> (p_start at time zone 'Asia/Jerusalem')::date then
    return (((p_start at time zone 'Asia/Jerusalem')::date + time '23:59') at time zone 'Asia/Jerusalem');
  end if;
  return v_end;
end;
$$;
revoke all on function public._round_up_ride_end(timestamptz, timestamptz) from public;
grant execute on function public._round_up_ride_end(timestamptz, timestamptz) to service_role;
