-- REQ §13.103 R3B3: leg-location refusals carry machine codes in DETAIL, never English prose (mapped in src/lib/rpc.ts).
create or replace function public.ride_requests_leg_location() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
        detail = 'keep_needs_own_origin';
    end if;
  elsif new.car_mode = 'chauffeur' then
    if v_ride_origin <> v_ride_destination or v_ride_origin not in (v_req_origin, v_req_destination) then
      raise exception 'leg_location_mismatch' using errcode = 'P0001',
        detail = 'chauffeur_same_place';
    end if;
  elsif new.car_mode = 'relay' then
    if v_req_destination is null then
      raise exception 'relay_requires_destination_id' using errcode = 'P0001',
        detail = 'relay_free_text_destination';
    end if;
    if new.leg = 'out' and (v_ride_origin <> v_req_origin or v_ride_destination <> v_req_destination) then
      raise exception 'leg_location_mismatch' using errcode = 'P0001',
        detail = 'relay_out_route';
    end if;
    if new.leg = 'return' and (v_ride_origin <> v_req_destination or v_ride_destination <> v_req_origin) then
      raise exception 'leg_location_mismatch' using errcode = 'P0001',
        detail = 'relay_return_route';
    end if;
  end if;

  return new;
end;
$$;
