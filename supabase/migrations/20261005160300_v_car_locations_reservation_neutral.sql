-- REQ §13.96: a Sadran reservation (ride with no served request, not an auto relocation) is location-neutral:
-- it holds time on a car but is ignored wherever the car's position is derived or checked.
-- v_car_locations: a reservation never makes a car "away" and never ends an away window. The predicate is
-- inline (not the closed helper) because the view is security_invoker; ride_requests is readable wherever its ride is.
create or replace view public.v_car_locations with (security_invoker = true) as
select r.car_id, r.department_id, r.week_start,
  r.ends_at as away_from,
  n.starts_at as away_until,
  r.destination_id as location_id,
  dl.name as location_name,
  r.id as leaving_ride_id,
  (r.overnight_ack_by is not null) as overnight_acknowledged
from public.rides r
join public.destinations dl on dl.id = r.destination_id
left join lateral (
  select n_1.starts_at from public.rides n_1
  where n_1.car_id = r.car_id and n_1.status <> 'cancelled' and n_1.starts_at > r.ends_at
    and (n_1.auto_relocation or exists (select 1 from public.ride_requests x where x.ride_id = n_1.id))
  order by n_1.starts_at limit 1) n on true
where r.status <> 'cancelled'
  and (r.auto_relocation or exists (select 1 from public.ride_requests x where x.ride_id = r.id))
  and r.destination_id is distinct from public.car_base_location(r.car_id);
