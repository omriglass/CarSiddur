-- TE1 (owner 2026-11-20): the straight-line estimate between two non-home places was half its length — the haversine in
-- place_travel() and _place_travel_for_week() lacked the factor 2 (d = 2R·asin(√a), as haversine_km() has). Full
-- definitions, unchanged except `6371 * 2 * asin(`.

CREATE OR REPLACE FUNCTION "public"."_place_travel_for_week"("p_department_id" "uuid", "p_week_start" "date") RETURNS TABLE("origin_id" "uuid", "destination_id" "uuid", "distance_km" numeric, "travel_minutes" integer, "source" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  return query
    with places as (
      select q.origin_id as place_id from public.requests q
        where q.department_id = p_department_id and q.week_start = p_week_start and q.origin_id is not null
      union
      select q.destination_id from public.requests q
        where q.department_id = p_department_id and q.week_start = p_week_start and q.destination_id is not null
      union
      select s.place_id from public.request_stops s join public.requests q on q.id = s.request_id
        where q.department_id = p_department_id and q.week_start = p_week_start and s.place_id is not null
      union
      select d.home_destination_id from public.departments d
        where d.id = p_department_id and d.home_destination_id is not null
    ),
    pairs as (
      select a.place_id as from_id, b.place_id as to_id,
             df.id as f_id, df.department_id as f_dept, df.lat as f_lat, df.lng as f_lng,
             df.distance_km as f_km, df.travel_minutes as f_min,
             dt.id as t_id, dt.department_id as t_dept, dt.lat as t_lat, dt.lng as t_lng,
             dt.distance_km as t_km, dt.travel_minutes as t_min
        from places a
        join places b on a.place_id < b.place_id
        left join public.destinations df on df.id = a.place_id
        left join public.destinations dt on dt.id = b.place_id
    ),
    judged as (
      select p.*, r.distance_km as r_km, r.travel_minutes as r_min, r.found as r_found,
             exists(select 1 from public.departments d where d.id = p.f_dept and d.home_destination_id = p.from_id) as home_from,
             exists(select 1 from public.departments d where d.id = p.t_dept and d.home_destination_id = p.to_id) as home_to,
             case when p.f_lat is not null and p.f_lng is not null and p.t_lat is not null and p.t_lng is not null then
               (6371 * 2 * asin(sqrt(
                   power(sin(radians(p.t_lat - p.f_lat) / 2), 2)
                   + cos(radians(p.f_lat)) * cos(radians(p.t_lat)) * power(sin(radians(p.t_lng - p.f_lng) / 2), 2)
                 ))) * 1.3
             end as est_km
        from pairs p
        left join lateral (
          select pd.distance_km, pd.travel_minutes, true as found from public.place_distances pd
           where pd.department_id = p.f_dept
             and ((pd.from_id = p.from_id and pd.to_id = p.to_id) or (pd.from_id = p.to_id and pd.to_id = p.from_id))
           order by (pd.from_id = p.from_id) desc
           limit 1) r on true
    )
    select j.from_id, j.to_id,
           case when j.f_id is null or j.t_id is null then null::numeric
                when j.r_found then j.r_km
                when j.home_from and not j.home_to then j.t_km
                when j.home_to and not j.home_from then j.f_km
                else round(j.est_km::numeric, 1) end,
           case when j.f_id is null or j.t_id is null then null::int
                when j.r_found then j.r_min
                when j.home_from and not j.home_to then j.t_min
                when j.home_to and not j.home_from then j.f_min
                else round(j.est_km::numeric)::int end,
           case when j.f_id is null or j.t_id is null then null::text
                when j.r_found then 'route'::text
                when j.home_from and not j.home_to then 'preset'::text
                when j.home_to and not j.home_from then 'preset'::text
                when j.est_km is not null then 'estimate'::text
                else null::text end
      from judged j;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."place_travel"("p_from" "uuid", "p_to" "uuid") RETURNS TABLE("distance_km" numeric, "travel_minutes" integer, "source" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
    v_km := (6371 * 2 * asin(sqrt(
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
