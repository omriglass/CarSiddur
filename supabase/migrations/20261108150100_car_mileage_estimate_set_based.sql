-- PF1: `car_mileage_totals` (1,501 calls, 0.6 s average in production on 2026-11-04) estimates each car's km by
-- calling `request_leg_route_km` once per served leg of the window's rides (~325 legs on the 2026-11-08 copy), each
-- building the leg's points and calling `place_travel` per hop. Now one query: every served leg's points (start,
-- active stops, end - `request_leg_route_points`' rule), each place pair's distance looked up once. Same numbers.

create or replace function public._car_mileage_estimate(p_department_id uuid, p_week_start date, p_weeks integer)
  returns table(car_id uuid, km numeric)
  language sql stable security definer set search_path = public, pg_temp as $$
  with
  served as (
    select c.id as car_id, s.request_id, s.leg
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
      ) s on true
     where c.department_id = p_department_id and c.type = 'shared' and c.status = 'active'
  ),
  legs as (
    select distinct sv.request_id, l.leg
      from served sv
      cross join lateral (values ('out'::public.ride_leg), ('return'::public.ride_leg)) l(leg)
     where sv.request_id is not null and (sv.leg = 'both' or sv.leg = l.leg)
  ),
  pts as (
    select lg.request_id, lg.leg, p.pos, p.ord, p.place_id
      from legs lg
      join public.requests q on q.id = lg.request_id
      cross join lateral (
        select 0 as pos, 0 as ord, case when lg.leg = 'out' then q.origin_id else q.destination_id end as place_id
        union all
        select s."position", 1, s.place_id
          from public.request_stops s
         where s.request_id = q.id and s.leg = lg.leg and (lg.leg = 'out' or q.return_at is not null)
        union all
        select (select count(*) from public.request_stops s
                 where s.request_id = q.id and s.leg = lg.leg and (lg.leg = 'out' or q.return_at is not null))::int + 1,
               2,
               case when lg.leg = 'out' then q.destination_id else q.origin_id end) p
  ),
  hops as (
    select p.request_id, p.leg, lag(p.place_id) over w as from_id, p.place_id as to_id, row_number() over w as i
      from pts p
    window w as (partition by p.request_id, p.leg order by p.pos, p.ord)
  ),
  pairs as (
    select distinct h.from_id, h.to_id from hops h where h.i > 1 and h.from_id is not null and h.to_id is not null
  ),
  dist as (
    select pr.from_id, pr.to_id, (select t.distance_km from public.place_travel(pr.from_id, pr.to_id) t) as km
      from pairs pr
  ),
  leg_km as (
    select h.request_id, h.leg, coalesce(sum(coalesce(d.km, 0)), 0) as km
      from hops h
      left join dist d on d.from_id = h.from_id and d.to_id = h.to_id
     where h.i > 1
     group by h.request_id, h.leg
  )
  select sv.car_id,
         coalesce(sum(
           case sv.leg
             when 'both' then coalesce(o.km, 0) + coalesce(rt.km, 0)
             when 'out' then coalesce(o.km, 0)
             when 'return' then coalesce(rt.km, 0)
             else 0
           end
         ), 0)::numeric
    from served sv
    left join leg_km o on o.request_id = sv.request_id and o.leg = 'out'
    left join leg_km rt on rt.request_id = sv.request_id and rt.leg = 'return'
   group by sv.car_id;
$$;
