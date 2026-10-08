-- REQ §13.112 (a): payload shape of the new `alternative` proposal type -- the placement of the request's plan B:
-- `car_id` (the car for the drop-off; `return_car_id` for the pickup when it differs), `depart_at` (when the car leaves
-- with the member), `return_at` (when the member is back at the origin = pickup time + the drive; only when the plan B
-- has a pickup, within 4 hours after `pickup_at`) plus the plan B itself copied from
-- request_alternatives at creation (`drop_place_id`/`drop_place_text`, `arrive_by`, `pickup_at`).
-- Full create-or-replace of the function from 20261008100250 / schema-current (one new `when`).
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
    when 'alternative' then _payload ? 'car_id' and _payload ? 'depart_at'
    else false
  end;
$$;

-- _validate_alternative_payload(request, payload): create_proposal's check for an `alternative` draft. Returns the payload
-- completed with the plan B read from the request's own row (the row, not the caller, is the source of the places and
-- times). Refusals: `alternative_not_applicable` (the request has no plan B, is already served by one, is not an
-- unmet הלוך-חזור / הלוך בלבד request), `alternative_payload_invalid` (cars/times).
create or replace function public._validate_alternative_payload(p_request_id uuid, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  q public.requests%rowtype; a public.request_alternatives%rowtype;
  v_car uuid; v_ret_car uuid; v_dep timestamptz; v_ret timestamptz; v_day date;
begin
  select * into q from public.requests where id = p_request_id;
  select * into a from public.request_alternatives where request_id = p_request_id;
  if a.id is null or q.fallback <> 'alternative' or q.served_by_alternative or a.applied_at is not null
     or q.trip_type not in ('round_trip', 'one_way') or q.series_id is not null
     or q.status not in ('submitted', 'waitlisted') then
    raise exception 'alternative_not_applicable' using errcode = 'P0001';
  end if;
  v_car := nullif(p_payload ->> 'car_id', '')::uuid;
  v_ret_car := coalesce(nullif(p_payload ->> 'return_car_id', '')::uuid, v_car);
  v_dep := nullif(p_payload ->> 'depart_at', '')::timestamptz;
  v_ret := nullif(p_payload ->> 'return_at', '')::timestamptz;
  v_day := (a.arrive_by at time zone 'Asia/Jerusalem')::date;
  if v_car is null or v_dep is null
     or not exists (select 1 from public.cars c where c.id = v_car and c.department_id = q.department_id and c.status = 'active')
     or not exists (select 1 from public.cars c where c.id = v_ret_car and c.department_id = q.department_id and c.status = 'active')
     or not public.is_quarter_hour(v_dep) or v_dep >= a.arrive_by
     or (v_dep at time zone 'Asia/Jerusalem')::date <> v_day
     or (a.pickup and (v_ret is null or not public.is_quarter_hour(v_ret) or v_ret < a.pickup_at or v_ret > a.pickup_at + interval '4 hours'))
     or (not a.pickup and v_ret is not null) then
    raise exception 'alternative_payload_invalid' using errcode = 'P0001';
  end if;
  return jsonb_build_object('car_id', v_car, 'return_car_id', v_ret_car, 'depart_at', v_dep, 'return_at', v_ret,
    'drop_place_id', a.drop_place_id, 'drop_place_text', a.drop_place_text, 'arrive_by', a.arrive_by,
    'pickup', a.pickup, 'pickup_at', a.pickup_at)
    || case when p_payload ? 'allow_small_trunk' then jsonb_build_object('allow_small_trunk', p_payload -> 'allow_small_trunk') else '{}'::jsonb end;
end $$;
revoke all on function public._validate_alternative_payload(uuid, jsonb) from public, anon, authenticated;
