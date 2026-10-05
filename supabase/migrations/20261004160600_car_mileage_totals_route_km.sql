-- car_mileage_totals: route km = Σ hop km (REQ §13.93 "Multi-stop rides";
-- ORIGINS_PLAN §6.2 item 4), keyed off the served request's own leg direction
-- (`ride_requests.leg`) instead of comparing the ride's own origin/destination columns --
-- a round trip ('both') counts its out leg and its return leg, a one-way/drop-off leg
-- ('out'/'return') counts only itself. With no stops this is the same single-hop distance
-- as before (and still doubled for a round trip, matching today's figure exactly).
create or replace function public.car_mileage_totals(p_department_id uuid, p_week_start date, p_weeks integer default 4)
returns table(car_id uuid, km numeric)
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not public.member_of(p_department_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  return query
    select c.id,
      coalesce(sum(
        case served.leg
          when 'both' then coalesce(public.request_leg_route_km(served.request_id, 'out'), 0)
                           + coalesce(public.request_leg_route_km(served.request_id, 'return'), 0)
          when 'out' then coalesce(public.request_leg_route_km(served.request_id, 'out'), 0)
          when 'return' then coalesce(public.request_leg_route_km(served.request_id, 'return'), 0)
          else 0
        end
      ), 0)::numeric as km
    from public.cars c
    left join public.rides r
      on r.car_id = c.id
      and r.status <> 'cancelled'
      and r.week_start >= p_week_start - (p_weeks * 7)
      and r.week_start <= p_week_start
      and (r.week_start < p_week_start or r.status = 'confirmed')
    left join lateral (
      select rq.request_id, rq.leg
      from public.ride_requests rq
      where rq.ride_id = r.id
      order by case when rq.role = 'driver' then 0 else 1 end, rq.request_id
      limit 1
    ) served on true
    where c.department_id = p_department_id and c.type = 'shared' and c.status = 'active'
    group by c.id;
end;
$$;
