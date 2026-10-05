-- REQ §13.96: a Sadran reservation (ride with no served request, not an auto relocation) is location-neutral:
-- it holds time on a car but is ignored wherever the car's position is derived or checked.
-- car_next_ride_origin(): next non-reservation ride.
CREATE OR REPLACE FUNCTION "public"."car_next_ride_origin"("_car" "uuid", "_after" timestamp with time zone) RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select r.origin_id from public.rides r
  where r.car_id = _car and r.status <> 'cancelled' and not r.planning_conflict
    and (not r.auto_relocation or r.driver_id is not null)
    and not public.ride_is_reservation(r.id)
    and r.starts_at >= _after
  order by r.starts_at asc limit 1;
$$;
