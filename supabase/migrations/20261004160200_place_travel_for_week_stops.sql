-- `place_travel_for_week` also returns every consecutive hop of every request's out/return
-- route, stops included (REQ §13.93 "Multi-stop rides"; ORIGINS_PLAN §6.2). With no stops a
-- request's route is just its one origin→destination hop, already covered by the original
-- query below -- this only adds rows for requests that have stops.
create or replace function public.place_travel_for_week(p_department_id uuid, p_week_start date)
returns table(origin_id uuid, destination_id uuid, distance_km numeric, travel_minutes int, source text)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_home uuid;
begin
  if not public.member_of(p_department_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  select home_destination_id into v_home from public.departments where id = p_department_id;
  return query
    select distinct merged.origin_id, merged.destination_id, merged.distance_km, merged.travel_minutes, merged.source
    from (
      select q.origin_id, q.destination_id, pt.distance_km, pt.travel_minutes, pt.source
      from public.requests q
      cross join lateral public.place_travel(q.origin_id, q.destination_id) pt
      where q.department_id = p_department_id and q.week_start = p_week_start
        and q.origin_id is not null and q.destination_id is not null
        and q.origin_id is distinct from v_home

      union all

      select hop.from_id as origin_id, hop.to_id as destination_id, pt2.distance_km, pt2.travel_minutes, pt2.source
      from public.requests q2
      cross join lateral (values ('out'::public.ride_leg), ('return'::public.ride_leg)) legs(leg)
      cross join lateral (
        select a.place_id as from_id, b.place_id as to_id
        from public.request_leg_route_points(q2.id, legs.leg) a
        join public.request_leg_route_points(q2.id, legs.leg) b on b."position" = a."position" + 1
      ) hop
      cross join lateral public.place_travel(hop.from_id, hop.to_id) pt2
      where q2.department_id = p_department_id and q2.week_start = p_week_start
        and hop.from_id is not null and hop.to_id is not null
        and hop.from_id is distinct from hop.to_id
        and exists (select 1 from public.request_stops s where s.request_id = q2.id and s.leg = legs.leg)
    ) merged;
end;
$$;
