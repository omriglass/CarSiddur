-- REQ §13.77 — a multi-day series' legs are `keep` legs that do not start and end at home.
--
-- The car leaves home on day 1, sleeps at the destination, and comes back on the last day:
--   leg 1        home        -> destination
--   middle legs  destination -> destination
--   last leg     destination -> home
-- `ride_requests_leg_location()` (20260907090800_rides.sql) requires every `keep`/`chauffeur`
-- leg to start and end at home, which is right for a single-day round trip and wrong for a
-- series. Regenerated in full from the live definition with that one carve-out; the relay
-- rules and the driver/requester rule are untouched.
create or replace function public.ride_requests_leg_location()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_home uuid;
  v_dept uuid;
  v_ride_origin uuid;
  v_ride_destination uuid;
  v_req_destination uuid;
  v_ride_driver uuid;
  v_req_requester uuid;
  v_series uuid;
begin
  select r.origin_id, r.destination_id, r.driver_id, r.department_id, r.series_id
    into v_ride_origin, v_ride_destination, v_ride_driver, v_dept, v_series
  from public.rides r where r.id = new.ride_id;
  select d.home_destination_id into v_home from public.departments d where d.id = v_dept;
  select q.destination_id, q.requester_id into v_req_destination, v_req_requester
  from public.requests q where q.id = new.request_id;

  if new.role = 'driver' and v_ride_driver <> v_req_requester then
    raise exception 'driver_row_requester_mismatch' using errcode = 'P0001';
  end if;

  if new.car_mode in ('keep','chauffeur') then
    -- REQ §13.77: a multi-day series' legs chain home -> destination -> … -> home; the car
    -- stays with the same member throughout, so "keep" legs of a series are exempt from the
    -- ordinary home -> home rule. place_series() is the only writer of these locations.
    if v_series is null and (v_ride_origin <> v_home or v_ride_destination <> v_home) then
      raise exception 'leg_location_mismatch' using errcode = 'P0001',
        detail = 'keep/chauffeur legs require the ride to start and end at home';
    end if;
  elsif new.car_mode = 'relay' then
    if v_req_destination is null then
      raise exception 'relay_requires_destination_id' using errcode = 'P0001',
        detail = 'a free-text destination can never relay (REQ §13.58)';
    end if;
    if new.leg = 'out' and (v_ride_origin <> v_home or v_ride_destination <> v_req_destination) then
      raise exception 'leg_location_mismatch' using errcode = 'P0001',
        detail = 'relay out leg must go home -> request destination';
    end if;
    if new.leg = 'return' and (v_ride_origin <> v_req_destination or v_ride_destination <> v_home) then
      raise exception 'leg_location_mismatch' using errcode = 'P0001',
        detail = 'relay return leg must go request destination -> home';
    end if;
  end if;

  return new;
end;
$function$;
