-- REQ §13.95 (merge detours): deciding whether a guest's places can be inserted into a host
-- ride's route needs travel between *any* two places of the week — the guest's origin to a
-- stop of the host's route, its destination to the host's destination, and so on. Until now
-- `place_travel_for_week` only returned each request's own hops, so the solver and the board's
-- route twin fell back to `defaultTravelMinutes` (60) for every insertion hop and refused
-- nearly every detour against the 20-minute limit. It now returns every unordered pair of the
-- distinct list places the week's requests use (origins, destinations, stops) plus the
-- department home; lookups on both sides already match a pair in either direction
-- (`travelBetween`, `makeHop`). Same signature and columns; full create-or-replace.
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
    )
    select a.place_id, b.place_id, pt.distance_km, pt.travel_minutes, pt.source
    from places a
    join places b on a.place_id < b.place_id
    cross join lateral public.place_travel(a.place_id, b.place_id) pt;
end;
$$;
