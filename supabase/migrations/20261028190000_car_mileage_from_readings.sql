-- REQ item 150 (g) / item 84: the solver's mileage balancing prefers kilometres actually driven (odometer readings,
-- phase 1) over the ride-distance estimate. Rule: readings are used for EVERY car of the department only when
-- ALL its active shared cars have usable readings in the window; otherwise the estimate is used for all
-- (readings-derived and estimated km are different scales and must never be compared with each other).
-- The previous body of car_mileage_totals is kept verbatim as the internal estimate helper.

drop function public.car_mileage_totals(uuid, date, integer);

create or replace function public._car_mileage_estimate(p_department_id uuid, p_week_start date, p_weeks integer)
returns table(car_id uuid, km numeric)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
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
revoke all on function public._car_mileage_estimate(uuid, date, integer) from public;

-- Kilometres driven per active shared car inside [window start, end of the target week), from odometer readings.
-- Points = the car's readings inside the window plus the last reading before it (the baseline). Between two
-- consecutive points the km are max(next - previous, 0); a 'correction' point starts a new baseline (the step
-- INTO it counts nothing, never a negative distance). A step that crosses the window start counts only its
-- share inside the window (linear in time). `usable` = at least one non-correction step and the covered time
-- (last point - max(first point, window start)) is at least 7 days.
create or replace function public._car_mileage_readings(p_department_id uuid, p_week_start date, p_weeks integer)
returns table(car_id uuid, km numeric, usable boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  with bounds as (
    select ((p_week_start - p_weeks * 7)::timestamp at time zone 'Asia/Jerusalem') as ws,
           ((p_week_start + 7)::timestamp at time zone 'Asia/Jerusalem') as we
  ),
  pts as (
    select r.car_id, r.km, r.kind, r.recorded_at, r.id
    from public.car_odometer_readings r, bounds b
    where r.department_id = p_department_id and r.recorded_at >= b.ws and r.recorded_at < b.we
    union all
    (select distinct on (r.car_id) r.car_id, r.km, r.kind, r.recorded_at, r.id
     from public.car_odometer_readings r, bounds b
     where r.department_id = p_department_id and r.recorded_at < b.ws
     order by r.car_id, r.recorded_at desc, r.id desc)
  ),
  seq as (
    select p.car_id, p.km, p.kind, p.recorded_at,
           lag(p.km) over w as pkm, lag(p.recorded_at) over w as pat
    from pts p
    window w as (partition by p.car_id order by p.recorded_at, p.id)
  ),
  tr as (
    select s.car_id, s.recorded_at,
      case when s.pkm is null or s.kind = 'correction' then null
           else greatest(s.km - s.pkm, 0) * case
             when s.pat < b.ws then extract(epoch from (s.recorded_at - b.ws))
                                    / nullif(extract(epoch from (s.recorded_at - s.pat)), 0)
             else 1 end
      end as d
    from seq s, bounds b
  ),
  agg as (
    select t.car_id, coalesce(sum(t.d), 0) as km, count(t.d) as steps,
           max(t.recorded_at) - greatest(min(t.recorded_at), (select ws from bounds)) as covered
    from tr t group by t.car_id
  )
  select c.id, coalesce(a.km, 0)::numeric,
         coalesce(a.steps >= 1 and a.covered >= interval '7 days', false)
  from public.cars c left join agg a on a.car_id = c.id
  where c.department_id = p_department_id and c.type = 'shared' and c.status = 'active';
$$;
revoke all on function public._car_mileage_readings(uuid, date, integer) from public;

create or replace function public.car_mileage_totals(p_department_id uuid, p_week_start date, p_weeks integer default 4)
returns table(car_id uuid, km numeric, source text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_use_readings boolean;
begin
  if not public.member_of(p_department_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  select count(*) > 0 and bool_and(rd.usable) into v_use_readings
  from public._car_mileage_readings(p_department_id, p_week_start, p_weeks) rd;

  if v_use_readings then
    return query select rd.car_id, rd.km, 'readings'::text
      from public._car_mileage_readings(p_department_id, p_week_start, p_weeks) rd;
  else
    return query select e.car_id, e.km, 'estimate'::text
      from public._car_mileage_estimate(p_department_id, p_week_start, p_weeks) e;
  end if;
end;
$$;
revoke all on function public.car_mileage_totals(uuid, date, integer) from public;
grant execute on function public.car_mileage_totals(uuid, date, integer) to authenticated, service_role;
