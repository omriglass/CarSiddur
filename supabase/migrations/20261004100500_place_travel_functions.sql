-- Distance/travel-time lookup and car-location helpers (REQ §13.93, ORIGINS_PLAN §2 items 6-7).
-- `place_travel` is an internal helper (no grant to authenticated, stays closed by the default
-- `revoke all on functions from public` in 20260907091400_rls.sql — hard rule 4): it is only
-- ever called from inside another SECURITY DEFINER function, never directly from the browser.
-- `place_travel_for_week` and `car_start_locations` ARE browser-facing (solver bridge, admin
-- policy preview) and are granted to `authenticated` with their own `member_of` guard.
--
-- Placement/healing behaviour (car_mileage_totals switching to place_travel, reserve_live_one_way_
-- slot/joinable_rides_for_request becoming origin-aware, …) is explicitly out of scope here
-- (ORIGINS_PLAN §3, step O3) — these functions are additive and unused by any existing caller.

create or replace function public.place_travel(p_from uuid, p_to uuid)
returns table (distance_km numeric, travel_minutes int, source text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_from public.destinations;
  v_to public.destinations;
  v_route public.place_distances;
  v_home_from boolean;
  v_home_to boolean;
  v_km numeric;
begin
  if p_from = p_to then
    return query select 0::numeric, 0, 'same'::text;
    return;
  end if;

  select * into v_from from public.destinations where id = p_from;
  select * into v_to from public.destinations where id = p_to;
  if v_from.id is null or v_to.id is null then
    return query select null::numeric, null::int, null::text;
    return;
  end if;

  select * into v_route from public.place_distances pd
    where pd.department_id = v_from.department_id
      and ((pd.from_id = p_from and pd.to_id = p_to) or (pd.from_id = p_to and pd.to_id = p_from))
    limit 1;
  if v_route.id is not null then
    return query select v_route.distance_km, v_route.travel_minutes, 'route'::text;
    return;
  end if;

  v_home_from := exists(select 1 from public.departments d where d.id = v_from.department_id and d.home_destination_id = p_from);
  v_home_to := exists(select 1 from public.departments d where d.id = v_to.department_id and d.home_destination_id = p_to);
  if v_home_from and not v_home_to then
    return query select v_to.distance_km, v_to.travel_minutes, 'preset'::text;
    return;
  elsif v_home_to and not v_home_from then
    return query select v_from.distance_km, v_from.travel_minutes, 'preset'::text;
    return;
  end if;

  if v_from.lat is not null and v_from.lng is not null and v_to.lat is not null and v_to.lng is not null then
    v_km := (6371 * asin(sqrt(
        power(sin(radians(v_to.lat - v_from.lat) / 2), 2)
        + cos(radians(v_from.lat)) * cos(radians(v_to.lat)) * power(sin(radians(v_to.lng - v_from.lng) / 2), 2)
      ))) * 1.3;
    -- 60 km/h: minutes = km / 60 * 60, i.e. numerically equal to the (road-factored) km.
    return query select round(v_km, 1), round(v_km)::int, 'estimate'::text;
    return;
  end if;

  return query select null::numeric, null::int, null::text;
end;
$$;

create or replace function public.place_travel_for_week(p_department_id uuid, p_week_start date)
returns table (origin_id uuid, destination_id uuid, distance_km numeric, travel_minutes int, source text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_home uuid;
begin
  if not public.member_of(p_department_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  select home_destination_id into v_home from public.departments where id = p_department_id;
  return query
    select distinct q.origin_id, q.destination_id, pt.distance_km, pt.travel_minutes, pt.source
    from public.requests q
    cross join lateral public.place_travel(q.origin_id, q.destination_id) pt
    where q.department_id = p_department_id and q.week_start = p_week_start
      and q.origin_id is not null and q.destination_id is not null
      and q.origin_id is distinct from v_home;
end;
$$;

revoke execute on function public.place_travel_for_week(uuid, date) from public, anon;
grant execute on function public.place_travel_for_week(uuid, date) to authenticated;

-- Base location a car returns to absent any ride: its own base_location_id, else (temporary
-- car) its owner's default origin for the car's department, else the department home.
create or replace function public.car_base_location(_car uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select c.base_location_id from public.cars c where c.id = _car),
    (select dm.default_origin_id from public.cars c
       join public.department_members dm on dm.department_id = c.department_id and dm.profile_id = c.owner_id
       where c.id = _car and c.type = 'temporary' and dm.removed_at is null),
    (select d.home_destination_id from public.cars c join public.departments d on d.id = c.department_id where c.id = _car));
$$;

-- Full create-or-replace (hard rule 8): only the final fallback changes, from the department
-- home directly to car_base_location() (home unless a base/owner-default is set).
create or replace function public.car_location_at(_car uuid, _at timestamptz) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select r.destination_id from public.rides r
      where r.car_id = _car and r.status <> 'cancelled' and r.starts_at <= _at
      order by r.starts_at desc limit 1),
    public.car_base_location(_car));
$$;

create or replace function public.car_start_locations(p_department_id uuid, p_week_start date)
returns table (car_id uuid, location_id uuid, base_location_id uuid)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_at timestamptz;
begin
  if not public.member_of(p_department_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  v_at := (p_week_start::timestamp) at time zone 'Asia/Jerusalem';
  return query
    select c.id, public.car_location_at(c.id, v_at), public.car_base_location(c.id)
    from public.cars c
    where c.department_id = p_department_id and c.status <> 'retired';
end;
$$;

revoke execute on function public.car_start_locations(uuid, date) from public, anon;
grant execute on function public.car_start_locations(uuid, date) to authenticated;
