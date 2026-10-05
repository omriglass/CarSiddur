-- REQ §13.94: a shift proposal may carry only a `car_id` (place the request on that car at its own
-- times), for every trip type — the board sends { car_id, depart_at?, return_at?, origin/destination?, stops? }.
-- create_proposal() needs no change (it already passes `car_id` through); the payload-shape check does.
CREATE OR REPLACE FUNCTION validate_proposal_payload(_type proposal_type, _payload jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
  select case _type
    when 'shift' then _payload ? 'depart_at' or _payload ? 'return_at' or _payload ? 'car_id'
      or _payload ? 'origin_id' or _payload ? 'origin_text'
      or _payload ? 'destination_id' or _payload ? 'destination_text' or _payload ? 'stops'
    when 'merge' then _payload ? 'ride_id' and _payload ? 'legs'
    when 'deny' then _payload ? 'reason'
    when 'external' then _payload ? 'hint' and _payload ? 'reason'
    when 'origin' then _payload ? 'origin_id' and _payload ? 'car_id'
    else false
  end;
$$;
