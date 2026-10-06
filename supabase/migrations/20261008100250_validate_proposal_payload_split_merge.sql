-- REQ §13.102 d (R2M2): a merge proposal may carry legs on two different rides (out on A, return on B), so the
-- payload need not name one `ride_id`; it needs a non-empty `legs` array whose entries each name a ride.
create or replace function public.validate_proposal_payload(_type public.proposal_type, _payload jsonb) returns boolean
language sql immutable as $$
  select case _type
    when 'shift' then _payload ? 'series_span' or _payload ? 'depart_at' or _payload ? 'return_at' or _payload ? 'car_id'
      or _payload ? 'origin_id' or _payload ? 'origin_text'
      or _payload ? 'destination_id' or _payload ? 'destination_text' or _payload ? 'stops'
    when 'merge' then _payload ? 'legs' and jsonb_typeof(_payload -> 'legs') = 'array' and jsonb_array_length(_payload -> 'legs') > 0
      and not exists (select 1 from jsonb_array_elements(_payload -> 'legs') l where not (l ? 'ride_id'))
    when 'deny' then _payload ? 'reason'
    when 'external' then _payload ? 'hint' and _payload ? 'reason'
    when 'origin' then _payload ? 'origin_id' and _payload ? 'car_id'
    else false
  end;
$$;
