-- O3 (REQ §13.93, ORIGINS_PLAN §3): car_mileage_totals() switches from the served request's
-- destination's own (home-anchored) `distance_km` to `place_travel(origin, destination)` --
-- the general origin-to-destination figure (ORIGINS_PLAN §2 item 6). The "×2 for a closed loop"
-- rule is unchanged, now keyed off the ride's own `origin_id = destination_id` (a `keep` or
-- chauffeur round trip) rather than always meaning "at home". Full create-or-replace (hard rule 8).
create or replace function public.car_mileage_totals(p_department_id uuid, p_week_start date, p_weeks integer default 4)
returns table (car_id uuid, km numeric)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.member_of(p_department_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  return query
    select c.id,
      coalesce(sum(
        coalesce(travel.distance_km, 0)
        * case when r.origin_id = r.destination_id then 2 else 1 end
      ), 0)::numeric as km
    from public.cars c
    left join public.rides r
      on r.car_id = c.id
      and r.status <> 'cancelled'
      and r.week_start >= p_week_start - (p_weeks * 7)
      and r.week_start <= p_week_start
      and (r.week_start < p_week_start or r.status = 'confirmed')
    left join lateral (
      select rq.request_id
      from public.ride_requests rq
      where rq.ride_id = r.id
      order by case when rq.role = 'driver' then 0 else 1 end, rq.request_id
      limit 1
    ) served on true
    left join public.requests req on req.id = served.request_id
    left join lateral (
      select pt.distance_km from public.place_travel(req.origin_id, req.destination_id) pt
    ) travel on req.origin_id is not null and req.destination_id is not null
    where c.department_id = p_department_id and c.type = 'shared' and c.status = 'active'
    group by c.id;
end;
$$;
