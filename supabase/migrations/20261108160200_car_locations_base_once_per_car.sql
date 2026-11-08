-- PF1: `v_car_locations` (every siddur / my-rides refresh; 8,357 calls, 194 ms average in production) called
-- `car_base_location(car_id)` for every ride of the week (86 on the 2026-11-08 copy) although a week has ~10 cars.
-- The call now sits in a lateral subquery on the car id, which the planner memoizes per car (74 of 82 lookups were
-- cache hits on the copy): 8.2 → 5.7 ms for a member's week, identical rows. Same columns, still security_invoker.

create or replace view public.v_car_locations with (security_invoker = true) as
 select r.car_id,
    r.department_id,
    r.week_start,
    r.ends_at as away_from,
    n.starts_at as away_until,
    r.destination_id as location_id,
    dl.name as location_name,
    r.id as leaving_ride_id,
    (r.overnight_ack_by is not null) as overnight_acknowledged
   from public.rides r
     join public.destinations dl on dl.id = r.destination_id
     join lateral (select public.car_base_location(r.car_id) as base_id offset 0) b on true
     left join lateral (
       select n_1.starts_at
         from public.rides n_1
        where n_1.car_id = r.car_id and n_1.status <> 'cancelled' and n_1.starts_at > r.ends_at
          and (n_1.auto_relocation or exists (select 1 from public.ride_requests x where x.ride_id = n_1.id))
        order by n_1.starts_at
        limit 1) n on true
  where r.status <> 'cancelled'
    and (r.auto_relocation or exists (select 1 from public.ride_requests x where x.ride_id = r.id))
    and r.destination_id is distinct from b.base_id;
