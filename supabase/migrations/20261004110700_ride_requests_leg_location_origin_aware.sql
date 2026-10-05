-- O3 (REQ §13.93, ORIGINS_PLAN §3): ride_requests_leg_location() is origin-aware instead of
-- home-anchored: `keep` requires the ride to start and end at the request's own origin;
-- `relay` out/return legs run origin<->destination (unchanged shape, just no longer assumes
-- origin = home); `chauffeur` requires the ride to start and end at the SAME place, and that
-- place must be either the leg's origin or its destination (the two ends `try_widen_one_way_leg`
-- is now allowed to anchor on, ORIGINS_PLAN §3). The REQ §13.77 series "keep" exemption (a
-- multi-day series chains origin -> destination -> ... -> origin, place_series() is the only
-- writer) is unchanged. Full create-or-replace (hard rule 8).
create or replace function public.ride_requests_leg_location() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ride_origin uuid;
  v_ride_destination uuid;
  v_req_origin uuid;
  v_req_destination uuid;
  v_ride_driver uuid;
  v_req_requester uuid;
  v_series uuid;
begin
  select r.origin_id, r.destination_id, r.driver_id, r.series_id
    into v_ride_origin, v_ride_destination, v_ride_driver, v_series
  from public.rides r where r.id = new.ride_id;
  select q.origin_id, q.destination_id, q.requester_id into v_req_origin, v_req_destination, v_req_requester
  from public.requests q where q.id = new.request_id;

  if new.role = 'driver' and v_ride_driver is distinct from v_req_requester
    and not exists (
      select 1 from public.request_companions rc join public.profiles p on p.id = rc.profile_id
      where rc.request_id = new.request_id and rc.profile_id = v_ride_driver and not p.does_not_drive)
  then
    raise exception 'driver_row_requester_mismatch' using errcode = 'P0001';
  end if;

  if new.car_mode = 'keep' then
    -- REQ §13.77: a multi-day series' legs chain origin -> destination -> … -> origin; the car
    -- stays with the same member throughout, so "keep" legs of a series are exempt from the
    -- ordinary origin -> origin rule. place_series() is the only writer of these locations.
    if v_series is null and (v_ride_origin <> v_req_origin or v_ride_destination <> v_req_origin) then
      raise exception 'leg_location_mismatch' using errcode = 'P0001',
        detail = 'keep legs require the ride to start and end at the request''s own origin';
    end if;
  elsif new.car_mode = 'chauffeur' then
    if v_ride_origin <> v_ride_destination or v_ride_origin not in (v_req_origin, v_req_destination) then
      raise exception 'leg_location_mismatch' using errcode = 'P0001',
        detail = 'chauffeur legs must start and end at the same place, which must be the leg''s origin or destination';
    end if;
  elsif new.car_mode = 'relay' then
    if v_req_destination is null then
      raise exception 'relay_requires_destination_id' using errcode = 'P0001',
        detail = 'a free-text destination can never relay (REQ §13.58)';
    end if;
    if new.leg = 'out' and (v_ride_origin <> v_req_origin or v_ride_destination <> v_req_destination) then
      raise exception 'leg_location_mismatch' using errcode = 'P0001',
        detail = 'relay out leg must go request origin -> request destination';
    end if;
    if new.leg = 'return' and (v_ride_origin <> v_req_destination or v_ride_destination <> v_req_origin) then
      raise exception 'leg_location_mismatch' using errcode = 'P0001',
        detail = 'relay return leg must go request destination -> request origin';
    end if;
  end if;

  return new;
end;
$$;
