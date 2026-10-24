-- Down for 20261028190000_car_mileage_from_readings.sql: restore the estimate-only car_mileage_totals and drop the helpers.
begin;
drop function if exists public.car_mileage_totals(uuid, date, integer);
drop function if exists public._car_mileage_readings(uuid, date, integer);
drop function if exists public._car_mileage_estimate(uuid, date, integer);

create or replace function public.car_mileage_totals(p_department_id uuid, p_week_start date, p_weeks integer DEFAULT 4) RETURNS TABLE(car_id uuid, km numeric)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
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


revoke all on function public.car_mileage_totals(uuid, date, integer) from public;
grant execute on function public.car_mileage_totals(uuid, date, integer) to authenticated, service_role;
commit;
