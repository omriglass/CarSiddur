-- PF1: `place_travel_for_week` (board input; 2,094 calls, 272 ms average in production) called `place_travel` once
-- per pair of the week's places (~600 pairs on the 2026-11-08 copy, 16 ms). Now one query over all pairs with
-- `place_travel`'s rule: stored route (either direction) → home preset → haversine × 1.3 at 60 km/h → nothing.
-- Same rows as before; where a route is stored in both directions the pair's own direction wins (was arbitrary).

create or replace function public.place_travel_for_week(p_department_id uuid, p_week_start date)
  returns table(origin_id uuid, destination_id uuid, distance_km numeric, travel_minutes integer, source text)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.member_of(p_department_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
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
               (6371 * asin(sqrt(
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
