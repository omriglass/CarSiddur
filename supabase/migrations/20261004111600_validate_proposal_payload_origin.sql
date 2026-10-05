-- O3 (REQ §13.93, ORIGINS_PLAN §3/§4): validate_proposal_payload()'s `proposals_payload_shape_ck`
-- check constraint needs an `origin` branch too, or create_proposal()'s own insert for the new
-- type fails the CHECK unconditionally (the function's `else false` default). Full
-- create-or-replace (hard rule 8); payload shape mirrors create_proposal()'s own light
-- validation (origin_id + car_id).
create or replace function public.validate_proposal_payload(_type public.proposal_type, _payload jsonb) returns boolean
language sql immutable as $$
  select case _type
    when 'shift' then _payload ? 'depart_at' or _payload ? 'return_at'
    when 'merge' then _payload ? 'ride_id' and _payload ? 'legs'
    when 'deny' then _payload ? 'reason'
    when 'external' then _payload ? 'hint' and _payload ? 'reason'
    when 'origin' then _payload ? 'origin_id' and _payload ? 'car_id'
    else false
  end;
$$;
