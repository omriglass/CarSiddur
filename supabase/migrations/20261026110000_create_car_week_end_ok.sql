-- REQ §13.136 (c): "never away from base at week end", SQL side.
-- True when ending a ride at _end_place leaves the shared car somewhere acceptable: either the car's next
-- ride (from _after on) starts there, or there is no next ride and the place is the car's base
-- (cars.base_location_id, else the department home; an unknown base never refuses).
-- Used only by AUTOMATIC placements; a Sadran's manual placement and an accepted proposal are never refused by it.
create or replace function public.car_week_end_ok(_car uuid, _after timestamptz, _end_place uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select case
    when n.origin_id is not null then n.origin_id is not distinct from _end_place
    else public.car_base_location(_car) is null
         or public.car_base_location(_car) is not distinct from _end_place
  end
  from (select public.car_next_ride_origin(_car, _after) as origin_id) n;
$$;
