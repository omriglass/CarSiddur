-- QA run 11 (REQ §13.112 a, R11M1): a plan-B proposal payload without a car is refused with its own code (alternative_car_required);
-- no silent car pick. Full create-or-replace of _validate_alternative_payload from supabase/schema-current.sql.
CREATE OR REPLACE FUNCTION "public"."_validate_alternative_payload"("p_request_id" "uuid", "p_payload" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  q public.requests%rowtype; a public.request_alternatives%rowtype;
  v_car uuid; v_ret_car uuid; v_dep timestamptz; v_ret timestamptz; v_day date; v_diff boolean;
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
  -- R11M1 (owner 2026-10-08): the server never picks a car for a plan-B proposal; the Sadran's choice (board suggestion or composer) is required.
  if v_car is null then raise exception 'alternative_car_required' using errcode = 'P0001'; end if;
  v_day := (a.arrive_by at time zone 'Asia/Jerusalem')::date;
  -- a pickup from another place is its own request (sibling) at apply: the proposal then carries no `return_at`, the pickup car and the exact pickup time
  v_diff := a.pickup and (a.pickup_place_id is not null or a.pickup_place_text is not null);
  if v_car is null or v_dep is null
     or not exists (select 1 from public.cars c where c.id = v_car and c.department_id = q.department_id and c.status = 'active')
     or not exists (select 1 from public.cars c where c.id = v_ret_car and c.department_id = q.department_id and c.status = 'active')
     or not public.is_quarter_hour(v_dep) or v_dep >= a.arrive_by
     or (v_dep at time zone 'Asia/Jerusalem')::date <> v_day
     or (a.pickup and not v_diff and (v_ret is null or not public.is_quarter_hour(v_ret) or v_ret < a.pickup_at or v_ret > a.pickup_at + interval '4 hours'))
     or ((not a.pickup or v_diff) and v_ret is not null) then
    raise exception 'alternative_payload_invalid' using errcode = 'P0001';
  end if;
  return jsonb_build_object('car_id', v_car, 'return_car_id', v_ret_car, 'depart_at', v_dep, 'return_at', v_ret,
    'drop_place_id', a.drop_place_id, 'drop_place_text', a.drop_place_text, 'arrive_by', a.arrive_by,
    'pickup', a.pickup, 'pickup_at', a.pickup_at,
    'pickup_place_id', a.pickup_place_id, 'pickup_place_text', a.pickup_place_text)
    || case when p_payload ? 'allow_small_trunk' then jsonb_build_object('allow_small_trunk', p_payload -> 'allow_small_trunk') else '{}'::jsonb end;
end $$;
