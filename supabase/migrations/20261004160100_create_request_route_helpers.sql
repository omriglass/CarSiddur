-- Route and time helpers for multi-stop legs (REQ §13.93 "Multi-stop rides";
-- docs/ORIGINS_PLAN_2026-10.md §6.2). One definition per side: `request_leg_route_points()`
-- is the internal ordered list of places a leg visits (start endpoint, each request_stops
-- row, end endpoint); every other helper here is built on top of it, so a later change to
-- the route shape only touches this one function.
--
-- Internal only -- not granted to `authenticated`; called from within other SECURITY
-- DEFINER functions (try_auto_approve, reserve_live_one_way_slot, try_widen_one_way_leg,
-- pair_one_way_legs, car_mileage_totals, place_travel_for_week, joinable_rides_for_request,
-- request_route_label) which run as their owner regardless of grants.
create or replace function public.request_leg_route_points(p_request_id uuid, p_leg public.ride_leg)
returns table("position" smallint, place_id uuid, place_text text)
stable security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_req public.requests%rowtype;
  v_start_id uuid; v_start_text text; v_end_id uuid; v_end_text text;
  v_stop_count smallint;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null then return; end if;
  if p_leg = 'out' then
    v_start_id := v_req.origin_id; v_start_text := v_req.origin_text;
    v_end_id := v_req.destination_id; v_end_text := v_req.destination_text;
  elsif p_leg = 'return' then
    v_start_id := v_req.destination_id; v_start_text := v_req.destination_text;
    v_end_id := v_req.origin_id; v_end_text := v_req.origin_text;
  else
    return; -- 'both' has no stored request_stops rows; callers always pass 'out'/'return'.
  end if;

  select count(*) into v_stop_count from public.request_stops s
  where s.request_id = p_request_id and s.leg = p_leg;

  return query
    select 0::smallint, v_start_id, v_start_text
    union all
    select s."position", s.place_id, s.place_text
    from public.request_stops s where s.request_id = p_request_id and s.leg = p_leg
    union all
    select (v_stop_count + 1)::smallint, v_end_id, v_end_text
    order by 1;
end;
$$;

revoke all on function public.request_leg_route_points(uuid, public.ride_leg) from public;
grant all on function public.request_leg_route_points(uuid, public.ride_leg) to service_role;

-- Leg route minutes = Σ travel(consecutive places) + stop_minutes × number of stops on that
-- leg (§6.2); a hop with no resolvable distance (free text on either side, or no data) falls
-- back to 30 minutes, the existing SQL fallback used throughout try_auto_approve et al. With
-- no stops the single hop reduces to today's plain place_travel() figure.
create or replace function public.request_leg_route_minutes(p_request_id uuid, p_leg public.ride_leg)
returns int
stable security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_dept uuid; v_stop_minutes int; v_total int := 0; v_stop_count int;
  v_prev record; v_cur record; v_has_prev boolean := false;
begin
  select department_id into v_dept from public.requests where id = p_request_id;
  if v_dept is null then return null; end if;

  select stop_minutes into v_stop_minutes from public.department_settings where department_id = v_dept;
  v_stop_minutes := coalesce(v_stop_minutes, 5);

  select count(*) into v_stop_count from public.request_stops s
  where s.request_id = p_request_id and s.leg = p_leg;

  for v_cur in select * from public.request_leg_route_points(p_request_id, p_leg) order by "position" loop
    if v_has_prev then
      v_total := v_total + greatest(coalesce(
        case when v_prev.place_id is not null and v_cur.place_id is not null
          then (select travel_minutes from public.place_travel(v_prev.place_id, v_cur.place_id))
        end, 30), 0);
    end if;
    v_prev := v_cur;
    v_has_prev := true;
  end loop;

  return v_total + v_stop_count * v_stop_minutes;
end;
$$;

revoke all on function public.request_leg_route_minutes(uuid, public.ride_leg) from public;
grant all on function public.request_leg_route_minutes(uuid, public.ride_leg) to service_role;

-- Route km = Σ hop km (a free-text hop contributes 0, same treatment car_mileage_totals
-- already gave an unknown distance). Internal only -- car_mileage_totals is its one caller.
create or replace function public.request_leg_route_km(p_request_id uuid, p_leg public.ride_leg)
returns numeric
stable security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_total numeric := 0; v_prev record; v_cur record; v_has_prev boolean := false;
begin
  for v_cur in select * from public.request_leg_route_points(p_request_id, p_leg) order by "position" loop
    if v_has_prev then
      v_total := v_total + coalesce(
        case when v_prev.place_id is not null and v_cur.place_id is not null
          then (select distance_km from public.place_travel(v_prev.place_id, v_cur.place_id))
        end, 0);
    end if;
    v_prev := v_cur;
    v_has_prev := true;
  end loop;
  return v_total;
end;
$$;

revoke all on function public.request_leg_route_km(uuid, public.ride_leg) from public;
grant all on function public.request_leg_route_km(uuid, public.ride_leg) to service_role;

-- ETA at each stop (not the endpoints): out ETAs count forward from depart_at, return ETAs
-- count backward from return_at (arrival at the origin). Referenced directly from
-- `v_my_requests`/`v_board_rides` (security_invoker views queried as `authenticated`), so --
-- unlike the three helpers above -- this one needs the PostgREST grant; classified
-- 'read-helper' in department_isolation.sql (same category as request_served_by_public_ride/
-- is_request_companion: a per-id derived-data reader with no cross-department enumeration).
create or replace function public.request_stop_etas(p_request_id uuid)
returns table(leg public.ride_leg, "position" smallint, place_id uuid, place_text text, eta timestamptz)
stable security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_req public.requests%rowtype;
  v_stop record;
  v_t timestamptz;
  v_anchor_id uuid; v_anchor_text text;
  v_stop_minutes int;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null then return; end if;
  select stop_minutes into v_stop_minutes from public.department_settings where department_id = v_req.department_id;
  v_stop_minutes := coalesce(v_stop_minutes, 5);

  if v_req.depart_at is not null then
    v_t := v_req.depart_at;
    v_anchor_id := v_req.origin_id; v_anchor_text := v_req.origin_text;
    for v_stop in
      select * from public.request_stops s where s.request_id = p_request_id and s.leg = 'out' order by s."position"
    loop
      v_t := v_t + make_interval(mins => greatest(coalesce(
        case when v_anchor_id is not null and v_stop.place_id is not null
          then (select travel_minutes from public.place_travel(v_anchor_id, v_stop.place_id)) end, 30), 0));
      leg := 'out'; "position" := v_stop."position"; place_id := v_stop.place_id; place_text := v_stop.place_text; eta := v_t;
      return next;
      v_t := v_t + make_interval(mins => v_stop_minutes);
      v_anchor_id := v_stop.place_id; v_anchor_text := v_stop.place_text;
    end loop;
  end if;

  if v_req.return_at is not null then
    v_t := v_req.return_at;
    v_anchor_id := v_req.origin_id; v_anchor_text := v_req.origin_text;  -- final arrival point
    for v_stop in
      select * from public.request_stops s where s.request_id = p_request_id and s.leg = 'return' order by s."position" desc
    loop
      v_t := v_t - make_interval(mins => greatest(coalesce(
        case when v_stop.place_id is not null and v_anchor_id is not null
          then (select travel_minutes from public.place_travel(v_stop.place_id, v_anchor_id)) end, 30), 0));
      leg := 'return'; "position" := v_stop."position"; place_id := v_stop.place_id; place_text := v_stop.place_text; eta := v_t;
      return next;
      v_t := v_t - make_interval(mins => v_stop_minutes);
      v_anchor_id := v_stop.place_id; v_anchor_text := v_stop.place_text;
    end loop;
  end if;
end;
$$;

revoke all on function public.request_stop_etas(uuid) from public;
grant all on function public.request_stop_etas(uuid) to service_role;
grant all on function public.request_stop_etas(uuid) to authenticated;
