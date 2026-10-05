-- REQ §13.96: a Sadran reservation (ride with no served request, not an auto relocation) is location-neutral:
-- it holds time on a car but is ignored wherever the car's position is derived or checked.
-- car_location_at(): last non-reservation ride that started.
CREATE OR REPLACE FUNCTION "public"."car_location_at"("_car" "uuid", "_at" timestamp with time zone) RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select coalesce(
    (select r.destination_id from public.rides r
      where r.car_id = _car and r.status <> 'cancelled' and r.starts_at <= _at
        and not public.ride_is_reservation(r.id)
      order by r.starts_at desc limit 1),
    public.car_base_location(_car));
$$;
