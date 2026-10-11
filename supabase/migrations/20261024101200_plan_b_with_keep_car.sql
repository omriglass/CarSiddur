-- Owner 2026-10-11 (REQ §13.126 g): plan B ("אם אין רכב…") together with "הרכב זמין לשימוש ביעד". A kept-car request
-- (trip_type 'drop_off' + keep_car_at_destination) may carry a plan B like a round trip: _save_request_alternative,
-- _validate_alternative_payload and _apply_alternative accept it; applying the plan B turns the request into the plain
-- plan-B הקפצה (flag off, the flag kept in original_main) and _restore_original_main brings it back. v_board_rides' served
-- entries carry keep_car_at_destination so the board never labels such a trip "הקפצה". Full definitions from schema-current.sql.

CREATE OR REPLACE FUNCTION "public"."_save_request_alternative"("p_request_id" "uuid", "p_payload" "jsonb", "p_old_depart" timestamp with time zone) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  q public.requests%rowtype; a public.request_alternatives%rowtype; v_alt jsonb;
  v_has_alt boolean; v_explicit boolean; v_day date; v_old_day date; v_shift int;
  v_place uuid; v_text text; v_arrive timestamptz; v_pickup boolean; v_pickup_at timestamptz;
  v_ppl uuid; v_ptx text;
begin
  select * into q from public.requests where id = p_request_id;
  select * into a from public.request_alternatives where request_id = p_request_id;
  v_alt := p_payload -> 'alternative';
  v_has_alt := coalesce(jsonb_typeof(v_alt) = 'object', false);
  v_explicit := (p_payload ? 'fallback' and q.fallback <> 'none') or v_has_alt;

  if v_explicit and ((q.trip_type not in ('round_trip', 'one_way') and not (q.trip_type = 'drop_off' and q.keep_car_at_destination)) or q.series_id is not null) then
    raise exception 'fallback_not_allowed' using errcode = 'P0001';
  end if;
  if q.fallback = 'alternative' and not v_has_alt and a.id is null then
    raise exception 'alternative_required' using errcode = 'P0001';
  end if;
  v_day := (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date;

  if v_has_alt then
    v_place := nullif(v_alt ->> 'drop_place_id', '')::uuid;
    v_text := nullif(btrim(coalesce(v_alt ->> 'drop_place_text', '')), '');
    if (v_place is null) = (v_text is null) then raise exception 'invalid_alternative' using errcode = 'P0001'; end if;
    if v_place is not null and not exists (
      select 1 from public.destinations d where d.id = v_place and d.department_id = q.department_id and d.is_approved) then
      raise exception 'invalid_alternative' using errcode = 'P0001';
    end if;
    if (v_place is not null and v_place is not distinct from q.origin_id)
       or (v_text is not null and lower(v_text) = lower(btrim(coalesce(q.origin_text, '')))) then
      raise exception 'origin_equals_destination' using errcode = 'P0001';
    end if;
    v_arrive := nullif(v_alt ->> 'arrive_by', '')::timestamptz;
    v_pickup := coalesce((v_alt ->> 'pickup')::boolean, false);
    v_pickup_at := case when v_pickup then nullif(v_alt ->> 'pickup_at', '')::timestamptz end;
    if v_arrive is null or not public.is_quarter_hour(v_arrive)
       or (v_arrive at time zone 'Asia/Jerusalem')::date <> v_day then
      raise exception 'invalid_alternative_time' using errcode = 'P0001';
    end if;
    if v_pickup and (v_pickup_at is null or not public.is_quarter_hour(v_pickup_at) or v_pickup_at <= v_arrive
        or (v_pickup_at at time zone 'Asia/Jerusalem')::date <> v_day) then
      raise exception 'invalid_alternative_time' using errcode = 'P0001';
    end if;
    -- REQ §13.112 (a): a pickup from another place; the same place (or none given) is stored as null.
    v_ppl := nullif(v_alt ->> 'pickup_place_id', '')::uuid;
    v_ptx := nullif(btrim(coalesce(v_alt ->> 'pickup_place_text', '')), '');
    if (v_ppl is not null and v_ptx is not null) or (not v_pickup and (v_ppl is not null or v_ptx is not null)) then
      raise exception 'invalid_alternative' using errcode = 'P0001';
    end if;
    if v_ppl is not null then
      if not exists (select 1 from public.destinations d where d.id = v_ppl and d.department_id = q.department_id and d.is_approved) then
        raise exception 'invalid_alternative' using errcode = 'P0001';
      end if;
      if v_ppl is not distinct from q.origin_id then raise exception 'origin_equals_destination' using errcode = 'P0001'; end if;
      if v_ppl is not distinct from v_place then v_ppl := null; end if;
    end if;
    if v_ptx is not null then
      if lower(v_ptx) = lower(btrim(coalesce(q.origin_text, ''))) then raise exception 'origin_equals_destination' using errcode = 'P0001'; end if;
      if lower(v_ptx) = lower(coalesce(v_text, '')) then v_ptx := null; end if;
    end if;
    insert into public.request_alternatives (request_id, department_id, week_start, drop_place_id, drop_place_text,
      arrive_by, pickup, pickup_at, pickup_place_id, pickup_place_text)
    values (q.id, q.department_id, q.week_start, v_place, v_text, v_arrive, v_pickup, v_pickup_at, v_ppl, v_ptx)
    on conflict (request_id) do update set drop_place_id = excluded.drop_place_id, drop_place_text = excluded.drop_place_text,
      arrive_by = excluded.arrive_by, pickup = excluded.pickup, pickup_at = excluded.pickup_at,
      pickup_place_id = excluded.pickup_place_id, pickup_place_text = excluded.pickup_place_text;
  elsif p_payload ? 'alternative' and jsonb_typeof(v_alt) = 'null' then
    if q.fallback = 'alternative' then raise exception 'alternative_required' using errcode = 'P0001'; end if;
    delete from public.request_alternatives where request_id = q.id and applied_at is null;
  elsif a.id is not null and a.applied_at is null and p_old_depart is not null then
    -- no plan-B keys: keep it, moving it along with the main trip's day
    v_old_day := (p_old_depart at time zone 'Asia/Jerusalem')::date;
    v_shift := v_day - v_old_day;
    if v_shift <> 0 then
      update public.request_alternatives set
        arrive_by = ((arrive_by at time zone 'Asia/Jerusalem') + make_interval(days => v_shift)) at time zone 'Asia/Jerusalem',
        pickup_at = case when pickup_at is null then null
          else ((pickup_at at time zone 'Asia/Jerusalem') + make_interval(days => v_shift)) at time zone 'Asia/Jerusalem' end
      where id = a.id;
    end if;
  end if;
end $$;


ALTER FUNCTION "public"."_save_request_alternative"("p_request_id" "uuid", "p_payload" "jsonb", "p_old_depart" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_shift_place_on_car"("p_proposal_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  p public.proposals%rowtype; q public.requests%rowtype; v_leg text; v_old record; v_prev text; v_res uuid;
  v_has_dep boolean; v_has_ret boolean;
begin
  select * into p from public.proposals where id = p_proposal_id;
  select * into q from public.requests where id = p.request_id;
  v_leg := nullif(p.payload ->> 'leg', '');
  if v_leg is null and q.trip_type = 'drop_off' then
    v_has_dep := nullif(p.payload ->> 'depart_at', '') is not null;
    v_has_ret := nullif(p.payload ->> 'return_at', '') is not null;
    if v_has_ret and not v_has_dep then v_leg := 'return';
    elsif v_has_dep and not v_has_ret then v_leg := 'out'; end if;
  end if;
  if v_leg in ('out', 'return') and q.trip_type = 'drop_off' then
    for v_old in
      select rd.id from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
      where rr.request_id = q.id and rr.leg = v_leg::public.ride_leg and rd.status <> 'cancelled'
      order by rd.id for update of rd
    loop
      if exists(select 1 from public.ride_requests where ride_id = v_old.id and request_id <> q.id) then
        if p.created_via <> 'sadran' then raise exception 'shared_ride_requires_sadran' using errcode = 'P0001'; end if;
      else
        update public.rides set status = 'cancelled', cancelled_at = now(),
          cancelled_by = coalesce(p.created_by, q.requester_id), cancel_reason = 'REPLACED_BY_PROPOSAL' where id = v_old.id;
      end if;
      delete from public.ride_requests where ride_id = v_old.id and request_id = q.id and leg = v_leg::public.ride_leg;
    end loop;
    -- Only this leg is (re)placed; the other leg's ride stays exactly as it was.
    v_prev := coalesce(current_setting('app.place_only_leg', true), '');
    perform set_config('app.place_only_leg', v_leg, true);
    v_res := public.place_request_on_car(p.request_id, (p.payload ->> 'car_id')::uuid, p.created_via = 'sadran', p.created_by,
      nullif(p.payload ->> 'driver_id', '')::uuid,
      case when v_leg = 'out' then nullif(p.payload ->> 'depart_at', '')::timestamptz end,
      case when v_leg = 'return' then nullif(p.payload ->> 'return_at', '')::timestamptz end, 'PROPOSAL_APPLIED');
    perform set_config('app.place_only_leg', v_prev, true);
    return v_res;
  end if;
  return public.place_request_on_car(p.request_id, (p.payload ->> 'car_id')::uuid, p.created_via = 'sadran', p.created_by,
    nullif(p.payload ->> 'driver_id', '')::uuid, nullif(p.payload ->> 'depart_at', '')::timestamptz,
    nullif(p.payload ->> 'return_at', '')::timestamptz, 'PROPOSAL_APPLIED');
end $$;


ALTER FUNCTION "public"."_shift_place_on_car"("p_proposal_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_small_trunk_check"("p_request_ids" "uuid"[], "p_car_id" "uuid", "p_allow" boolean) RETURNS "void"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_ids uuid[];
begin
  if coalesce(p_allow, false) or p_car_id is null then return; end if;
  select array_agg(q.id order by q.id) into v_ids from public.requests q
  where q.id = any(p_request_ids) and q.has_luggage and q.luggage_waived_at is null;
  if v_ids is null then return; end if;
  if public.car_takes_luggage(p_car_id, cardinality(v_ids)) then return; end if;
  raise exception 'needs_large_trunk' using errcode = 'P0001', detail = public._small_trunk_detail(v_ids, p_car_id);
end $$;


ALTER FUNCTION "public"."_small_trunk_check"("p_request_ids" "uuid"[], "p_car_id" "uuid", "p_allow" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_small_trunk_detail"("p_request_ids" "uuid"[], "p_car_id" "uuid") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select jsonb_build_object(
    'request_ids', coalesce((select jsonb_agg(q.id order by q.id) from public.requests q where q.id = any(p_request_ids)), '[]'::jsonb),
    'names', coalesce((select jsonb_agg(p.full_name order by q.id) from public.requests q
                       join public.profiles p on p.id = q.requester_id where q.id = any(p_request_ids)), '[]'::jsonb),
    'car_id', p_car_id,
    'car_name', (select c.name from public.cars c where c.id = p_car_id))::text;
$$;

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
     or (q.trip_type not in ('round_trip', 'one_way') and not (q.trip_type = 'drop_off' and q.keep_car_at_destination)) or q.series_id is not null
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


ALTER FUNCTION "public"."_validate_alternative_payload"("p_request_id" "uuid", "p_payload" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_window_text"("_dep" timestamp with time zone, "_ret" timestamp with time zone) RETURNS "text"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select public._frag(case when _dep is not null and _ret is not null then 'window.both'
                           when _dep is not null then 'window.out' else 'window.return' end,
    jsonb_build_object('depart', coalesce(public._hhmm(_dep), ''), 'return', coalesce(public._hhmm(_ret), '')))
$$;

CREATE OR REPLACE FUNCTION "public"."_apply_alternative"("p_proposal_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  p public.proposals%rowtype; q public.requests%rowtype; a public.request_alternatives%rowtype;
  v_car uuid; v_ret_car uuid; v_dep timestamptz; v_ret timestamptz; v_orig jsonb; v_ride uuid; v_prev text;
  v_manual boolean; v_diff boolean; v_pickup_at timestamptz; v_sib uuid; v_sib_car uuid;
begin
  select * into p from public.proposals where id = p_proposal_id;
  select * into q from public.requests where id = p.request_id for update;
  select * into a from public.request_alternatives where request_id = q.id for update;
  if a.id is null or q.fallback <> 'alternative' or q.served_by_alternative or a.applied_at is not null
     or (q.trip_type not in ('round_trip', 'one_way') and not (q.trip_type = 'drop_off' and q.keep_car_at_destination)) or q.series_id is not null
     or q.status not in ('submitted', 'waitlisted', 'proposed')
     or exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                where rr.request_id = q.id and r.status <> 'cancelled') then
    raise exception 'alternative_not_applicable' using errcode = 'P0001';
  end if;
  -- the member changed the plan after the offer: what they accepted is not what is stored any more
  if a.arrive_by is distinct from (p.payload ->> 'arrive_by')::timestamptz
     or a.pickup_at is distinct from nullif(p.payload ->> 'pickup_at', '')::timestamptz
     or a.drop_place_id is distinct from nullif(p.payload ->> 'drop_place_id', '')::uuid
     or a.drop_place_text is distinct from nullif(p.payload ->> 'drop_place_text', '')
     or a.pickup_place_id is distinct from nullif(p.payload ->> 'pickup_place_id', '')::uuid
     or a.pickup_place_text is distinct from nullif(p.payload ->> 'pickup_place_text', '') then
    raise exception 'alternative_changed' using errcode = 'P0001';
  end if;
  v_car := (p.payload ->> 'car_id')::uuid;
  v_ret_car := coalesce(nullif(p.payload ->> 'return_car_id', '')::uuid, v_car);
  v_dep := (p.payload ->> 'depart_at')::timestamptz;
  v_ret := case when a.pickup then nullif(p.payload ->> 'return_at', '')::timestamptz end;
  v_manual := p.created_via = 'sadran';
  -- a pickup from another place becomes a sibling request (pickup place -> home); the parent keeps only the drop-off
  v_diff := a.pickup and (a.pickup_place_id is not null or a.pickup_place_text is not null);
  v_pickup_at := a.pickup_at;
  if v_diff then v_ret := null; end if;

  v_orig := jsonb_build_object(
    'trip_type', q.trip_type, 'trip_shape', q.trip_shape, 'one_way_car_mode', q.one_way_car_mode,
    'needs_car_at_destination', q.needs_car_at_destination,
    'destination_id', q.destination_id, 'destination_text', q.destination_text,
    'depart_at', q.depart_at, 'return_at', q.return_at, 'kept_return_at', q.kept_return_at,
    'flex_depart_early', q.flex_depart_early::text, 'flex_depart_late', q.flex_depart_late::text,
    'flex_return_early', q.flex_return_early::text, 'flex_return_late', q.flex_return_late::text,
    'depart_anchor', q.depart_anchor, 'arrive_by', q.arrive_by, 'return_anchor', q.return_anchor, 'leave_dest_at', q.leave_dest_at,
    'duration_locked', q.duration_locked, 'preferred_car_id', q.preferred_car_id,
    'keep_car_at_destination', q.keep_car_at_destination,
    'stops', coalesce((select jsonb_agg(jsonb_build_object('leg', s.leg, 'position', s."position",
        'place_id', s.place_id, 'place_text', s.place_text) order by s.leg, s."position")
      from public.request_stops s where s.request_id = q.id), '[]'::jsonb));

  perform set_config('app.request_anchors_explicit', 'on', true);
  perform set_config('app.duration_lock_explicit', 'on', true);
  update public.requests set
    trip_type = 'drop_off',
    -- REQ §13.126 g: the plan B is a plain הקפצה; the main trip's "car stays at the destination" lives on in original_main.
    keep_car_at_destination = false,
    trip_shape = case when a.pickup and not v_diff then 'round_trip'::public.trip_shape else 'one_way_to'::public.trip_shape end,
    needs_car_at_destination = false,
    one_way_car_mode = case when a.pickup and not v_diff then null
      else (select case when pr.does_not_drive then 'passenger' else 'relay' end::public.leg_car_mode
            from public.profiles pr where pr.id = q.requester_id) end,
    destination_id = a.drop_place_id, destination_text = a.drop_place_text,
    depart_at = v_dep, return_at = v_ret, kept_return_at = null,
    flex_depart_early = '0', flex_depart_late = '0', flex_return_early = '0', flex_return_late = '0',
    depart_anchor = 'arrive', arrive_by = a.arrive_by,
    return_anchor = case when a.pickup and not v_diff then 'leave'::public.time_anchor else 'arrive'::public.time_anchor end,
    leave_dest_at = case when a.pickup and not v_diff then a.pickup_at end,
    duration_locked = false, preferred_car_id = null, served_by_alternative = true,
    status = 'submitted', status_reason = 'ALTERNATIVE_PENDING_PLACEMENT'
  where id = q.id;
  perform set_config('app.request_anchors_explicit', 'off', true);
  perform set_config('app.duration_lock_explicit', 'off', true);
  -- the main trip's intermediate stops belong to the main route (they stay in original_main)
  delete from public.request_stops where request_id = q.id;

  if v_diff then
    insert into public.requests (department_id, week_start, requester_id, filed_by, destination_id, destination_text, ride_type_id,
      origin_id, origin_text, trip_type, trip_shape, depart_at, one_way_car_mode, needs_car_at_destination,
      adults, child_seats, boosters, has_luggage, luggage_waived_at, luggage_waived_by, notes, is_late, submitted_at, status,
      depart_anchor, return_anchor, served_by_alternative, plan_b_parent_id, ride_description, guest_passenger_names)
    values (q.department_id, q.week_start, q.requester_id, q.filed_by, q.origin_id, q.origin_text, q.ride_type_id,
      a.pickup_place_id, a.pickup_place_text, 'drop_off', 'one_way_to', v_pickup_at,
      (select case when pr.does_not_drive then 'passenger' else 'relay' end::public.leg_car_mode from public.profiles pr where pr.id = q.requester_id),
      false, q.adults, q.child_seats, q.boosters, q.has_luggage, q.luggage_waived_at, q.luggage_waived_by, q.notes, false, now(), 'submitted',
      'leave', 'arrive', true, q.id, q.ride_description, q.guest_passenger_names)
    returning id into v_sib;
    insert into public.request_companions (request_id, profile_id) select v_sib, profile_id from public.request_companions where request_id = q.id;
    insert into public.request_children (request_id, child_id) select v_sib, child_id from public.request_children where request_id = q.id;
    v_sib_car := v_ret_car;
  end if;
  if v_car = v_ret_car or not a.pickup or v_diff then
    v_ride := public.place_request_on_car(q.id, v_car, v_manual, p.created_by, null, v_dep, v_ret, 'PROPOSAL_APPLIED');
    if v_diff then
      perform public.place_request_on_car(v_sib, v_sib_car, v_manual, p.created_by, null, v_pickup_at, null, 'PROPOSAL_APPLIED');
    end if;
  else
    v_prev := coalesce(current_setting('app.place_only_leg', true), '');
    perform set_config('app.place_only_leg', 'out', true);
    v_ride := public.place_request_on_car(q.id, v_car, v_manual, p.created_by, null, v_dep, null, 'PROPOSAL_APPLIED');
    perform set_config('app.place_only_leg', 'return', true);
    perform public.place_request_on_car(q.id, v_ret_car, v_manual, p.created_by, null, null, v_ret, 'PROPOSAL_APPLIED');
    perform set_config('app.place_only_leg', v_prev, true);
  end if;

  -- every leg of the plan must hold a ride (a placement that found room for only one leg is no plan B)
  if not exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                 where rr.request_id = q.id and rr.covers_out and r.status <> 'cancelled')
     or (a.pickup and not v_diff and not exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                 where rr.request_id = q.id and rr.covers_return and r.status <> 'cancelled'))
     or (v_diff and not exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                 where rr.request_id = v_sib and rr.covers_out and r.status <> 'cancelled')) then
    raise exception 'alternative_unavailable' using errcode = 'P0001';
  end if;

  update public.request_alternatives set original_main = v_orig, applied_at = now() where id = a.id;
  return v_ride;
end $$;


ALTER FUNCTION "public"."_apply_alternative"("p_proposal_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_apply_series_span"("p_request_id" "uuid", "p_span" "jsonb", "p_car_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_head public.requests%rowtype; v_series uuid;
  v_dep timestamptz; v_ret timestamptz; v_first date; v_last date;
  v_n_in int; v_d_min date; v_d_max date; v_k int; v_i int := 0; v_leg record;
  v_prev_flag text := coalesce(current_setting('app.system_status_transition', true), '');
  v_applying text := coalesce(nullif(current_setting('app.applying_proposal', true), ''), '');
  v_actor uuid := (select auth.uid()); v_prop uuid; v_ride uuid; v_kept uuid; v_real_ret timestamptz;
begin
  select * into v_head from public.requests where id = p_request_id for update;
  if v_head.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  v_series := v_head.series_id;
  if v_series is null or v_head.series_index is distinct from 1 then
    raise exception 'series_span_requires_series_head' using errcode = 'P0001';
  end if;
  v_dep := nullif(p_span ->> 'depart_at', '')::timestamptz;
  v_ret := nullif(p_span ->> 'return_at', '')::timestamptz;
  if v_dep is null or v_ret is null or p_car_id is null
     or not public.is_quarter_hour(v_dep)
     or not (public.is_quarter_hour(v_ret) or (v_ret at time zone 'Asia/Jerusalem')::time = time '23:59') then
    raise exception 'series_span_invalid' using errcode = 'P0001';
  end if;
  v_first := (v_dep at time zone 'Asia/Jerusalem')::date;
  v_last := (v_ret at time zone 'Asia/Jerusalem')::date;
  -- REQ §13.105 d: down to a single day (first = last), as members can (REQ §13.103 c); only an inverted span is invalid.
  if v_first > v_last or v_ret <= v_dep then raise exception 'series_span_invalid' using errcode = 'P0001'; end if;
  -- REQ §13.105 d: a single day taken from the series is a real trip, not the held-all-day 00:00-23:59 of a middle leg:
  -- it leaves at the series' own departure time of day and returns at its own real return time of day.
  if v_first = v_last then
    if (v_dep at time zone 'Asia/Jerusalem')::time = time '00:00' then
      v_dep := (v_first + (v_head.depart_at at time zone 'Asia/Jerusalem')::time) at time zone 'Asia/Jerusalem';
    end if;
    if (v_ret at time zone 'Asia/Jerusalem')::time = time '23:59' then
      select max(q.return_at) into v_real_ret from public.requests q where q.series_id = v_series and q.status not in ('withdrawn', 'cancelled');
      if v_real_ret is not null and (v_real_ret at time zone 'Asia/Jerusalem')::time <> time '23:59' then
        v_real_ret := (v_last + (v_real_ret at time zone 'Asia/Jerusalem')::time) at time zone 'Asia/Jerusalem';
        if v_real_ret > v_dep and public.is_quarter_hour(v_real_ret) then v_ret := v_real_ret; end if;
      end if;
    end if;
    -- a real return that is not after the (moved) real departure: held until the end of the day instead
    if v_ret <= v_dep then v_ret := (v_last + time '23:59') at time zone 'Asia/Jerusalem'; end if;
    if v_ret <= v_dep then raise exception 'series_span_invalid' using errcode = 'P0001'; end if;
  end if;

  perform 1 from public.requests where series_id = v_series order by id for update;
  select count(*) filter (where d between v_first and v_last), min(d), max(d) into v_n_in, v_d_min, v_d_max
  from (select (q.depart_at at time zone 'Asia/Jerusalem')::date as d from public.requests q
        where q.series_id = v_series and q.status not in ('withdrawn', 'cancelled')) x;
  if v_first < v_d_min or v_last > v_d_max or v_n_in <> (v_last - v_first + 1) then
    raise exception 'series_span_invalid' using errcode = 'P0001';
  end if;
  v_k := v_n_in;

  -- Another request riding a series ride is not ours to cancel.
  if exists (select 1 from public.rides r
             join public.ride_requests rr on rr.ride_id = r.id
             join public.requests q on q.id = rr.request_id
             where r.series_id = v_series and r.status <> 'cancelled' and q.series_id is distinct from v_series) then
    raise exception 'series_span_shared_ride' using errcode = 'P0001';
  end if;

  perform set_config('app.system_status_transition', 'on', true);
  perform set_config('app.audit_reason', 'apply_series_span', true);

  -- Nothing else stays open on the series.
  for v_prop in select p.id from public.proposals p
      where p.request_id in (select q.id from public.requests q where q.series_id = v_series)
        and p.status in ('draft', 'sent', 'accepted') and p.id::text <> v_applying order by p.id loop
    if exists (select 1 from public.proposals where id = v_prop and status = 'draft') then
      update public.proposals set status = 'withdrawn' where id = v_prop;
    else
      perform public.proposal_system_withdraw(v_prop, 'withdrawn_edit');
    end if;
  end loop;

  -- REQ §13.105 d: a single kept day leaves the series: it becomes an ordinary request on the chosen car (the same
  -- shape as the member's own `shorten_series` to one day); every other day is withdrawn.
  if v_first = v_last then
    update public.rides set status = 'cancelled', cancelled_at = now(),
      cancelled_by = coalesce(v_actor, driver_id, created_by), cancel_reason = 'SERIES_SHORTENED'
    where series_id = v_series and status <> 'cancelled';
    delete from public.ride_requests where request_id in (select x.id from public.requests x where x.series_id = v_series);
    select x.id into v_kept from public.requests x where x.series_id = v_series and x.status not in ('withdrawn', 'cancelled')
      and (x.depart_at at time zone 'Asia/Jerusalem')::date = v_first;
    update public.requests set status = 'withdrawn', status_reason = 'SERIES_SHORTENED', series_id = null, series_index = null, series_count = null
    where series_id = v_series and status not in ('withdrawn', 'cancelled') and id <> v_kept;
    update public.requests set series_id = null, series_index = null, series_count = null, status = 'submitted',
      status_reason = 'PROPOSAL_APPLIED_PENDING_ASSIGNMENT', depart_at = v_dep, return_at = v_ret where id = v_kept;
    perform public.place_request_on_car(v_kept, p_car_id, true, v_actor, null, v_dep, v_ret, 'PROPOSAL_APPLIED');
    perform set_config('app.system_status_transition', v_prev_flag, true);
    select rr.ride_id into v_ride from public.ride_requests rr where rr.request_id = v_kept limit 1;
    return v_ride;
  end if;

  -- Rides: every series ride is released (dropped days for good, kept days to be placed again on the car).
  update public.rides set status = 'cancelled', cancelled_at = now(),
    cancelled_by = coalesce(v_actor, driver_id, created_by), cancel_reason = 'SERIES_SHORTENED'
  where series_id = v_series and status <> 'cancelled';

  -- Dropped days: withdrawn with a clear reason and detached from the series.
  update public.requests set status = 'withdrawn', status_reason = 'SERIES_SHORTENED',
    series_id = null, series_index = null, series_count = null
  where series_id = v_series and status not in ('withdrawn', 'cancelled')
    and (depart_at at time zone 'Asia/Jerusalem')::date not between v_first and v_last;

  -- Kept days: renumbered; the first/last leg take the span's own times.
  for v_leg in select q.id, (q.depart_at at time zone 'Asia/Jerusalem')::date as d from public.requests q
      where q.series_id = v_series and q.status not in ('withdrawn', 'cancelled') order by 2 loop
    v_i := v_i + 1;
    update public.requests set series_index = v_i, series_count = v_k,
      depart_at = case when v_i = 1 then v_dep else (v_leg.d::timestamp at time zone 'Asia/Jerusalem') end,
      return_at = case when v_i = v_k then v_ret else ((v_leg.d + time '23:59') at time zone 'Asia/Jerusalem') end
    where id = v_leg.id;
  end loop;

  perform public.place_series(v_series, p_car_id, true, 'PROPOSAL_APPLIED');

  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status_reason = 'PROPOSAL_APPLIED' where series_id = v_series and status = 'assigned';
  perform set_config('app.system_status_transition', v_prev_flag, true);

  select r.id into v_ride from public.rides r where r.series_id = v_series and r.status <> 'cancelled'
  order by r.starts_at limit 1;
  return v_ride;
end $$;


ALTER FUNCTION "public"."_apply_series_span"("p_request_id" "uuid", "p_span" "jsonb", "p_car_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_ask_to_join_ride_label"("p_ride_id" "uuid") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select public.day_date_label(r.starts_at) || ' ' || to_char(r.starts_at at time zone 'Asia/Jerusalem','HH24:MI') || '–'
    || to_char(r.ends_at at time zone 'Asia/Jerusalem','HH24:MI')
    || coalesce(' · ' || nullif(concat_ws(' · ', c.name, p.full_name), ''), '')
  from public.rides r left join public.cars c on c.id = r.car_id left join public.profiles p on p.id = r.driver_id
  where r.id = p_ride_id;
$$;

CREATE OR REPLACE FUNCTION "public"."_restore_original_main"("p_request_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare q public.requests%rowtype; a public.request_alternatives%rowtype; o jsonb; s record; st jsonb;
begin
  select * into q from public.requests where id = p_request_id for update;
  select * into a from public.request_alternatives where request_id = p_request_id for update;
  if a.id is null or a.original_main is null or not q.served_by_alternative then
    raise exception 'alternative_not_applied' using errcode = 'P0001';
  end if;
  o := a.original_main;
  perform public.release_request_booking(q.id);
  -- the pickup sibling (a pickup from another place) is removed with its rides; the parent is the one request again
  for s in select id from public.requests where plan_b_parent_id = q.id order by id loop
    perform public.release_request_booking(s.id);
    delete from public.requests where id = s.id;
  end loop;
  perform set_config('app.system_status_transition', 'on', true);
  perform set_config('app.request_anchors_explicit', 'on', true);
  perform set_config('app.duration_lock_explicit', 'on', true);
  update public.requests set
    trip_type = (o ->> 'trip_type')::public.trip_type, trip_shape = (o ->> 'trip_shape')::public.trip_shape,
    one_way_car_mode = nullif(o ->> 'one_way_car_mode', '')::public.leg_car_mode,
    needs_car_at_destination = (o ->> 'needs_car_at_destination')::boolean,
    destination_id = nullif(o ->> 'destination_id', '')::uuid, destination_text = nullif(o ->> 'destination_text', ''),
    depart_at = nullif(o ->> 'depart_at', '')::timestamptz, return_at = nullif(o ->> 'return_at', '')::timestamptz,
    kept_return_at = nullif(o ->> 'kept_return_at', '')::timestamptz,
    flex_depart_early = (o ->> 'flex_depart_early')::interval, flex_depart_late = (o ->> 'flex_depart_late')::interval,
    flex_return_early = (o ->> 'flex_return_early')::interval, flex_return_late = (o ->> 'flex_return_late')::interval,
    depart_anchor = (o ->> 'depart_anchor')::public.time_anchor, arrive_by = nullif(o ->> 'arrive_by', '')::timestamptz,
    return_anchor = (o ->> 'return_anchor')::public.time_anchor, leave_dest_at = nullif(o ->> 'leave_dest_at', '')::timestamptz,
    duration_locked = (o ->> 'duration_locked')::boolean, preferred_car_id = nullif(o ->> 'preferred_car_id', '')::uuid,
    keep_car_at_destination = coalesce((o ->> 'keep_car_at_destination')::boolean, false),
    served_by_alternative = false, status = 'submitted', status_reason = 'ALTERNATIVE_REVERTED'
  where id = q.id;
  perform set_config('app.request_anchors_explicit', 'off', true);
  perform set_config('app.duration_lock_explicit', 'off', true);
  perform set_config('app.system_status_transition', 'off', true);
  delete from public.request_stops where request_id = q.id;
  for st in select * from jsonb_array_elements(coalesce(o -> 'stops', '[]'::jsonb)) loop
    insert into public.request_stops (request_id, department_id, leg, "position", place_id, place_text)
    values (q.id, q.department_id, (st ->> 'leg')::public.ride_leg, (st ->> 'position')::smallint,
      nullif(st ->> 'place_id', '')::uuid, nullif(st ->> 'place_text', ''));
  end loop;
  update public.request_alternatives set original_main = null, applied_at = null where id = a.id;
end $$;


ALTER FUNCTION "public"."_restore_original_main"("p_request_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_ride_fp"("p_ride_id" "uuid", "p_status" "text" DEFAULT NULL::"text") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  -- p_status is kept for the old call shape; status no longer takes part (cancellation is checked separately).
  select md5((to_jsonb(r) - array['version','updated_at','starts_at','ends_at','turnaround_override_minutes','blocked_until','is_pinned','pin_reason',
    'driver_id','needs_driver','flag_reason','status','planning_conflict'])::text)
  from public.rides r where r.id = p_ride_id;
$$;

CREATE OR REPLACE VIEW "public"."v_board_rides" WITH ("security_invoker"='true') AS
 SELECT "id",
    "department_id",
    "week_start",
    "car_id",
    "starts_at",
    "ends_at",
    "blocked_until",
    "status",
    "is_pinned",
    "pin_reason",
    "version",
    "origin_id",
    "origin_name",
    "destination_id",
    "destination_name",
    "overflow_allowed",
    "overnight_ack_by",
    "driver_id",
    "driver_name",
    "is_chauffeur",
    "served",
    "notes",
    "needs_driver",
    "turnaround_override_minutes",
    "planning_conflict",
    "series_id",
    "series_index",
    "series_count",
    "passengers",
    "people",
    "auto_relocation",
    "relay_partner",
    "public"."ride_route_json"("id") AS "route"
   FROM ( SELECT "existing"."id",
            "existing"."department_id",
            "existing"."week_start",
            "existing"."car_id",
            "existing"."starts_at",
            "existing"."ends_at",
            "existing"."blocked_until",
            "existing"."status",
            "existing"."is_pinned",
            "existing"."pin_reason",
            "existing"."version",
            "existing"."origin_id",
            "existing"."origin_name",
            "existing"."destination_id",
            "existing"."destination_name",
            "existing"."overflow_allowed",
            "existing"."overnight_ack_by",
            "existing"."driver_id",
            "existing"."driver_name",
            "existing"."is_chauffeur",
            COALESCE("served_stops"."served", "existing"."served") AS "served",
            "existing"."notes",
            "existing"."needs_driver",
            "existing"."turnaround_override_minutes",
            "existing"."planning_conflict",
            "existing"."series_id",
            "existing"."series_index",
            "existing"."series_count",
            "existing"."passengers",
            "existing"."people",
            "existing"."auto_relocation",
            "existing"."relay_partner"
           FROM (( SELECT "existing_1"."id",
                    "existing_1"."department_id",
                    "existing_1"."week_start",
                    "existing_1"."car_id",
                    "existing_1"."starts_at",
                    "existing_1"."ends_at",
                    "existing_1"."blocked_until",
                    "existing_1"."status",
                    "existing_1"."is_pinned",
                    "existing_1"."pin_reason",
                    "existing_1"."version",
                    "existing_1"."origin_id",
                    "existing_1"."origin_name",
                    "existing_1"."destination_id",
                    "existing_1"."destination_name",
                    "existing_1"."overflow_allowed",
                    "existing_1"."overnight_ack_by",
                    "existing_1"."driver_id",
                    "existing_1"."driver_name",
                    "existing_1"."is_chauffeur",
                    "existing_1"."served",
                    "existing_1"."notes",
                    "existing_1"."needs_driver",
                    "existing_1"."turnaround_override_minutes",
                    "existing_1"."planning_conflict",
                    "existing_1"."series_id",
                    "existing_1"."series_index",
                    "existing_1"."series_count",
                    "existing_1"."passengers",
                    "existing_1"."people",
                    "existing_1"."auto_relocation",
                    "rp"."relay_partner"
                   FROM (( SELECT "existing_1_1"."id",
                            "existing_1_1"."department_id",
                            "existing_1_1"."week_start",
                            "existing_1_1"."car_id",
                            "existing_1_1"."starts_at",
                            "existing_1_1"."ends_at",
                            "existing_1_1"."blocked_until",
                            "existing_1_1"."status",
                            "existing_1_1"."is_pinned",
                            "existing_1_1"."pin_reason",
                            "existing_1_1"."version",
                            "existing_1_1"."origin_id",
                            "existing_1_1"."origin_name",
                            "existing_1_1"."destination_id",
                            "existing_1_1"."destination_name",
                            "existing_1_1"."overflow_allowed",
                            "existing_1_1"."overnight_ack_by",
                            "existing_1_1"."driver_id",
                            "existing_1_1"."driver_name",
                            "existing_1_1"."is_chauffeur",
                            "existing_1_1"."served",
                            "existing_1_1"."notes",
                            "existing_1_1"."needs_driver",
                            "existing_1_1"."turnaround_override_minutes",
                            "existing_1_1"."planning_conflict",
                            "existing_1_1"."series_id",
                            "existing_1_1"."series_index",
                            "existing_1_1"."series_count",
                            "existing_1_1"."passengers",
                            "existing_1_1"."people",
                            "r"."auto_relocation"
                           FROM (( SELECT "existing_1_1_1"."id",
                                    "existing_1_1_1"."department_id",
                                    "existing_1_1_1"."week_start",
                                    "existing_1_1_1"."car_id",
                                    "existing_1_1_1"."starts_at",
                                    "existing_1_1_1"."ends_at",
                                    "existing_1_1_1"."blocked_until",
                                    "existing_1_1_1"."status",
                                    "existing_1_1_1"."is_pinned",
                                    "existing_1_1_1"."pin_reason",
                                    "existing_1_1_1"."version",
                                    "existing_1_1_1"."origin_id",
                                    "existing_1_1_1"."origin_name",
                                    "existing_1_1_1"."destination_id",
                                    "existing_1_1_1"."destination_name",
                                    "existing_1_1_1"."overflow_allowed",
                                    "existing_1_1_1"."overnight_ack_by",
                                    "existing_1_1_1"."driver_id",
                                    "existing_1_1_1"."driver_name",
                                    "existing_1_1_1"."is_chauffeur",
                                    "existing_1_1_1"."served",
                                    "existing_1_1_1"."notes",
                                    "existing_1_1_1"."needs_driver",
                                    "existing_1_1_1"."turnaround_override_minutes",
                                    "existing_1_1_1"."planning_conflict",
                                    "existing_1_1_1"."series_id",
                                    "existing_1_1_1"."series_index",
                                    "existing_1_1_1"."series_count",
                                    "existing_1_1_1"."passengers",
                                    COALESCE(( SELECT "jsonb_agg"("jsonb_build_object"('key', "pe"."key", 'source', "pe"."source", 'request_id', "pe"."request_id", 'ride_passenger_id', "pe"."ride_passenger_id", 'person_id', "pe"."person_id", 'child_id', "pe"."child_id", 'display_name', "pe"."display_name", 'seat_kind', "pe"."seat_kind", 'added_by', "pe"."added_by", 'removable', "pe"."removable") ORDER BY "pe"."is_driver" DESC, "pe"."display_name", "pe"."key") AS "jsonb_agg"
   FROM ( SELECT ('driver:'::"text" || "existing_1_1_1"."driver_id") AS "key",
      'driver'::"text" AS "source",
      ( SELECT "q0"."id"
       FROM ("public"."ride_requests" "rr0"
         JOIN "public"."requests" "q0" ON (("q0"."id" = "rr0"."request_id")))
      WHERE (("rr0"."ride_id" = "existing_1_1_1"."id") AND ("q0"."requester_id" = "existing_1_1_1"."driver_id"))
     LIMIT 1) AS "request_id",
      NULL::"uuid" AS "ride_passenger_id",
      "existing_1_1_1"."driver_id" AS "person_id",
      NULL::"uuid" AS "child_id",
      "existing_1_1_1"."driver_name" AS "display_name",
      'adult'::"text" AS "seat_kind",
      NULL::"uuid" AS "added_by",
      false AS "removable",
      true AS "is_driver"
    WHERE ("existing_1_1_1"."driver_id" IS NOT NULL)
  UNION ALL
   SELECT ('req:'::"text" || "q"."id"),
      'requester'::"text" AS "text",
      "q"."id",
      NULL::"uuid" AS "uuid",
      "q"."requester_id",
      NULL::"uuid" AS "uuid",
      "p"."full_name",
      'adult'::"text" AS "text",
      NULL::"uuid" AS "uuid",
      true,
      false
     FROM (("public"."ride_requests" "rr"
       JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
       JOIN "public"."profiles" "p" ON (("p"."id" = "q"."requester_id")))
    WHERE (("rr"."ride_id" = "existing_1_1_1"."id") AND ("q"."requester_id" IS DISTINCT FROM "existing_1_1_1"."driver_id"))
  UNION ALL
   SELECT ((('comp:'::"text" || "q"."id") || ':'::"text") || "rc"."profile_id"),
      'companion'::"text" AS "text",
      "q"."id",
      NULL::"uuid" AS "uuid",
      "rc"."profile_id",
      NULL::"uuid" AS "uuid",
      "p"."full_name",
      'adult'::"text" AS "text",
      NULL::"uuid" AS "uuid",
      true,
      false
     FROM ((("public"."ride_requests" "rr"
       JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
       JOIN "public"."request_companions" "rc" ON (("rc"."request_id" = "q"."id")))
       JOIN "public"."profiles" "p" ON (("p"."id" = "rc"."profile_id")))
    WHERE ("rr"."ride_id" = "existing_1_1_1"."id")
  UNION ALL
   SELECT ((('child:'::"text" || "q"."id") || ':'::"text") || "rc"."child_id"),
      'child'::"text" AS "text",
      "q"."id",
      NULL::"uuid" AS "uuid",
      NULL::"uuid" AS "uuid",
      "rc"."child_id",
      "c"."full_name",
      'child_seat'::"text" AS "text",
      NULL::"uuid" AS "uuid",
      true,
      false
     FROM ((("public"."ride_requests" "rr"
       JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
       JOIN "public"."request_children" "rc" ON (("rc"."request_id" = "q"."id")))
       JOIN "public"."children" "c" ON (("c"."id" = "rc"."child_id")))
    WHERE ("rr"."ride_id" = "existing_1_1_1"."id")
  UNION ALL
   SELECT ((('guest:'::"text" || "q"."id") || ':'::"text") || "gn"."n"),
      'guest'::"text" AS "text",
      "q"."id",
      NULL::"uuid" AS "uuid",
      NULL::"uuid" AS "uuid",
      NULL::"uuid" AS "uuid",
      "gn"."name",
      'adult'::"text" AS "text",
      NULL::"uuid" AS "uuid",
      true,
      false
     FROM (("public"."ride_requests" "rr"
       JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
       CROSS JOIN LATERAL "unnest"("q"."guest_passenger_names") WITH ORDINALITY "gn"("name", "n"))
    WHERE ("rr"."ride_id" = "existing_1_1_1"."id")
  UNION ALL
   SELECT ('added:'::"text" || "rp_1"."id"),
      'added'::"text" AS "text",
      NULL::"uuid" AS "uuid",
      "rp_1"."id",
      "rp_1"."person_id",
      "rp_1"."child_id",
      "rp_1"."display_name",
      "rp_1"."seat_kind",
      "rp_1"."added_by",
      true,
      false
     FROM "public"."ride_passengers" "rp_1"
    WHERE ("rp_1"."ride_id" = "existing_1_1_1"."id")) "pe"("key", "source", "request_id", "ride_passenger_id", "person_id", "child_id", "display_name", "seat_kind", "added_by", "removable", "is_driver")), '[]'::"jsonb") AS "people"
                                   FROM ( SELECT "existing_1_1_1_1"."id",
    "existing_1_1_1_1"."department_id",
    "existing_1_1_1_1"."week_start",
    "existing_1_1_1_1"."car_id",
    "existing_1_1_1_1"."starts_at",
    "existing_1_1_1_1"."ends_at",
    "existing_1_1_1_1"."blocked_until",
    "existing_1_1_1_1"."status",
    "existing_1_1_1_1"."is_pinned",
    "existing_1_1_1_1"."pin_reason",
    "existing_1_1_1_1"."version",
    "existing_1_1_1_1"."origin_id",
    "existing_1_1_1_1"."origin_name",
    "existing_1_1_1_1"."destination_id",
    "existing_1_1_1_1"."destination_name",
    "existing_1_1_1_1"."overflow_allowed",
    "existing_1_1_1_1"."overnight_ack_by",
    "existing_1_1_1_1"."driver_id",
    "existing_1_1_1_1"."driver_name",
    "existing_1_1_1_1"."is_chauffeur",
    "existing_1_1_1_1"."served",
    "existing_1_1_1_1"."notes",
    "existing_1_1_1_1"."needs_driver",
    "existing_1_1_1_1"."turnaround_override_minutes",
    "existing_1_1_1_1"."planning_conflict",
    "existing_1_1_1_1"."series_id",
    "existing_1_1_1_1"."series_index",
    "existing_1_1_1_1"."series_count",
    COALESCE(( SELECT "jsonb_agg"("jsonb_build_object"('id', "rp_1"."id", 'person_id', "rp_1"."person_id", 'child_id', "rp_1"."child_id", 'display_name', "rp_1"."display_name", 'seat_kind', "rp_1"."seat_kind", 'added_by', "rp_1"."added_by") ORDER BY "rp_1"."created_at") AS "jsonb_agg"
     FROM "public"."ride_passengers" "rp_1"
    WHERE ("rp_1"."ride_id" = "existing_1_1_1_1"."id")), '[]'::"jsonb") AS "passengers"
   FROM ( SELECT "existing_1_1_1_1_1"."id",
      "existing_1_1_1_1_1"."department_id",
      "existing_1_1_1_1_1"."week_start",
      "existing_1_1_1_1_1"."car_id",
      "existing_1_1_1_1_1"."starts_at",
      "existing_1_1_1_1_1"."ends_at",
      "existing_1_1_1_1_1"."blocked_until",
      "existing_1_1_1_1_1"."status",
      "existing_1_1_1_1_1"."is_pinned",
      "existing_1_1_1_1_1"."pin_reason",
      "existing_1_1_1_1_1"."version",
      "existing_1_1_1_1_1"."origin_id",
      "existing_1_1_1_1_1"."origin_name",
      "existing_1_1_1_1_1"."destination_id",
      "existing_1_1_1_1_1"."destination_name",
      "existing_1_1_1_1_1"."overflow_allowed",
      "existing_1_1_1_1_1"."overnight_ack_by",
      "existing_1_1_1_1_1"."driver_id",
      "existing_1_1_1_1_1"."driver_name",
      "existing_1_1_1_1_1"."is_chauffeur",
      "existing_1_1_1_1_1"."served",
      "existing_1_1_1_1_1"."notes",
      "existing_1_1_1_1_1"."needs_driver",
      "existing_1_1_1_1_1"."turnaround_override_minutes",
      "existing_1_1_1_1_1"."planning_conflict",
      "r_1"."series_id",
      ( SELECT "q"."series_index"
       FROM ("public"."ride_requests" "rr"
         JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
      WHERE (("rr"."ride_id" = "existing_1_1_1_1_1"."id") AND ("q"."series_id" IS NOT NULL))
      ORDER BY "q"."series_index"
     LIMIT 1) AS "series_index",
      ( SELECT "q"."series_count"
       FROM ("public"."ride_requests" "rr"
         JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
      WHERE (("rr"."ride_id" = "existing_1_1_1_1_1"."id") AND ("q"."series_id" IS NOT NULL))
      ORDER BY "q"."series_index"
     LIMIT 1) AS "series_count"
     FROM (( SELECT "existing_1_1_1_1_1_1"."id",
        "existing_1_1_1_1_1_1"."department_id",
        "existing_1_1_1_1_1_1"."week_start",
        "existing_1_1_1_1_1_1"."car_id",
        "existing_1_1_1_1_1_1"."starts_at",
        "existing_1_1_1_1_1_1"."ends_at",
        "existing_1_1_1_1_1_1"."blocked_until",
        "existing_1_1_1_1_1_1"."status",
        "existing_1_1_1_1_1_1"."is_pinned",
        "existing_1_1_1_1_1_1"."pin_reason",
        "existing_1_1_1_1_1_1"."version",
        "existing_1_1_1_1_1_1"."origin_id",
        "existing_1_1_1_1_1_1"."origin_name",
        "existing_1_1_1_1_1_1"."destination_id",
        "existing_1_1_1_1_1_1"."destination_name",
        "existing_1_1_1_1_1_1"."overflow_allowed",
        "existing_1_1_1_1_1_1"."overnight_ack_by",
        "existing_1_1_1_1_1_1"."driver_id",
        "existing_1_1_1_1_1_1"."driver_name",
        "existing_1_1_1_1_1_1"."is_chauffeur",
        "existing_1_1_1_1_1_1"."served",
        "existing_1_1_1_1_1_1"."notes",
        "existing_1_1_1_1_1_1"."needs_driver",
        "existing_1_1_1_1_1_1"."turnaround_override_minutes",
        "r_1_1"."planning_conflict"
       FROM (( SELECT "existing_1_1_1_1_1_1_1"."id",
          "existing_1_1_1_1_1_1_1"."department_id",
          "existing_1_1_1_1_1_1_1"."week_start",
          "existing_1_1_1_1_1_1_1"."car_id",
          "existing_1_1_1_1_1_1_1"."starts_at",
          "existing_1_1_1_1_1_1_1"."ends_at",
          "existing_1_1_1_1_1_1_1"."blocked_until",
          "existing_1_1_1_1_1_1_1"."status",
          "existing_1_1_1_1_1_1_1"."is_pinned",
          "existing_1_1_1_1_1_1_1"."pin_reason",
          "existing_1_1_1_1_1_1_1"."version",
          "existing_1_1_1_1_1_1_1"."origin_id",
          "existing_1_1_1_1_1_1_1"."origin_name",
          "existing_1_1_1_1_1_1_1"."destination_id",
          "existing_1_1_1_1_1_1_1"."destination_name",
          "existing_1_1_1_1_1_1_1"."overflow_allowed",
          "existing_1_1_1_1_1_1_1"."overnight_ack_by",
          "existing_1_1_1_1_1_1_1"."driver_id",
          "existing_1_1_1_1_1_1_1"."driver_name",
          "existing_1_1_1_1_1_1_1"."is_chauffeur",
          "existing_1_1_1_1_1_1_1"."served",
          "existing_1_1_1_1_1_1_1"."notes",
          "r_1_1_1"."needs_driver",
          "r_1_1_1"."turnaround_override_minutes"
         FROM (( SELECT "r_1_1_1_1"."id",
            "r_1_1_1_1"."department_id",
            "r_1_1_1_1"."week_start",
            "r_1_1_1_1"."car_id",
            "r_1_1_1_1"."starts_at",
            "r_1_1_1_1"."ends_at",
            "r_1_1_1_1"."blocked_until",
            "r_1_1_1_1"."status",
            "r_1_1_1_1"."is_pinned",
            "r_1_1_1_1"."pin_reason",
            "r_1_1_1_1"."version",
            "r_1_1_1_1"."origin_id",
            "o"."name" AS "origin_name",
            "r_1_1_1_1"."destination_id",
            "e"."name" AS "destination_name",
            "r_1_1_1_1"."overflow_allowed",
            "r_1_1_1_1"."overnight_ack_by",
            "r_1_1_1_1"."driver_id",
            "d"."full_name" AS "driver_name",
            (NOT (EXISTS ( SELECT 1
             FROM "public"."ride_requests" "x"
            WHERE (("x"."ride_id" = "r_1_1_1_1"."id") AND ("x"."role" = 'driver'::"public"."ride_role"))))) AS "is_chauffeur",
            COALESCE("jsonb_agg"("jsonb_build_object"('request_id', "q"."id", 'role', "rr"."role", 'leg', "rr"."leg", 'car_mode', "rr"."car_mode", 'requester', "p"."full_name", 'destination', COALESCE("dst"."name", "q"."destination_text"), 'ride_type', "rt"."code", 'adults', "q"."adults", 'child_seats', "q"."child_seats", 'boosters', "q"."boosters", 'luggage', "q"."has_luggage", 'luggage_waived', ("q"."luggage_waived_at" IS NOT NULL), 'origin_id', "q"."origin_id", 'origin_text', "q"."origin_text", 'origin_name', ( SELECT "dd"."name"
             FROM "public"."destinations" "dd"
            WHERE ("dd"."id" = "q"."origin_id")), 'trip_type', "q"."trip_type", 'keep_car_at_destination', "q"."keep_car_at_destination", 'child_names', COALESCE(( SELECT "array_agg"("c"."full_name" ORDER BY "c"."full_name") AS "array_agg"
             FROM ("public"."request_children" "rc"
               JOIN "public"."children" "c" ON (("c"."id" = "rc"."child_id")))
            WHERE ("rc"."request_id" = "q"."id")), '{}'::"text"[]), 'ride_description', "q"."ride_description", 'guest_passenger_names', "q"."guest_passenger_names", 'companions', COALESCE(( SELECT "jsonb_agg"("jsonb_build_object"('profile_id', "p_1"."id", 'name', "p_1"."full_name") ORDER BY "p_1"."full_name", "p_1"."id") AS "jsonb_agg"
             FROM ("public"."request_companions" "rc"
               JOIN "public"."profiles" "p_1" ON (("p_1"."id" = "rc"."profile_id")))
            WHERE ("rc"."request_id" = "q"."id")), '[]'::"jsonb"), 'preferred_car_id', "q"."preferred_car_id", 'original_depart_at', "q"."original_depart_at", 'original_return_at', "q"."original_return_at") ORDER BY "rr"."role", "p"."full_name") FILTER (WHERE ("q"."id" IS NOT NULL)), '[]'::"jsonb") AS "served",
            "r_1_1_1_1"."notes"
           FROM (((((((("public"."rides" "r_1_1_1_1"
             JOIN "public"."destinations" "o" ON (("o"."id" = "r_1_1_1_1"."origin_id")))
             JOIN "public"."destinations" "e" ON (("e"."id" = "r_1_1_1_1"."destination_id")))
             LEFT JOIN "public"."profiles" "d" ON (("d"."id" = "r_1_1_1_1"."driver_id")))
             LEFT JOIN "public"."ride_requests" "rr" ON (("rr"."ride_id" = "r_1_1_1_1"."id")))
             LEFT JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
             LEFT JOIN "public"."profiles" "p" ON (("p"."id" = "q"."requester_id")))
             LEFT JOIN "public"."ride_types" "rt" ON (("rt"."id" = "q"."ride_type_id")))
             LEFT JOIN "public"."destinations" "dst" ON (("dst"."id" = "q"."destination_id")))
          WHERE ("r_1_1_1_1"."status" <> 'cancelled'::"public"."ride_status")
          GROUP BY "r_1_1_1_1"."id", "o"."name", "e"."name", "d"."full_name") "existing_1_1_1_1_1_1_1"
           JOIN "public"."rides" "r_1_1_1" ON (("r_1_1_1"."id" = "existing_1_1_1_1_1_1_1"."id")))) "existing_1_1_1_1_1_1"
         JOIN "public"."rides" "r_1_1" ON (("r_1_1"."id" = "existing_1_1_1_1_1_1"."id")))) "existing_1_1_1_1_1"
       JOIN "public"."rides" "r_1" ON (("r_1"."id" = "existing_1_1_1_1_1"."id")))) "existing_1_1_1_1") "existing_1_1_1") "existing_1_1"
                             JOIN "public"."rides" "r" ON (("r"."id" = "existing_1_1"."id")))) "existing_1"
                     LEFT JOIN LATERAL ( SELECT "jsonb_build_object"('ride_id', "x"."ride_id", 'name', COALESCE("x"."driver_name", "x"."first_requester"), 'at', "x"."at") AS "relay_partner"
                           FROM (( SELECT "nr"."id" AS "ride_id",
                                    "nr"."starts_at" AS "at",
                                    "dp"."full_name" AS "driver_name",
                                    ( SELECT "p"."full_name"
   FROM (("public"."ride_requests" "rr"
     JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
     JOIN "public"."profiles" "p" ON (("p"."id" = "q"."requester_id")))
  WHERE ("rr"."ride_id" = "nr"."id")
  ORDER BY "rr"."created_at"
 LIMIT 1) AS "first_requester"
                                   FROM ("public"."rides" "nr"
                                     LEFT JOIN "public"."profiles" "dp" ON (("dp"."id" = "nr"."driver_id")))
                                  WHERE ((EXISTS ( SELECT 1
   FROM "jsonb_array_elements"("existing_1"."served") "e"("value")
  WHERE ((("e"."value" ->> 'role'::"text") = 'driver'::"text") AND (("e"."value" ->> 'car_mode'::"text") = 'relay'::"text") AND (("e"."value" ->> 'leg'::"text") = 'out'::"text")))) AND ("nr"."id" <> "existing_1"."id") AND ("nr"."car_id" = "existing_1"."car_id") AND ("nr"."department_id" = "existing_1"."department_id") AND ("nr"."week_start" = "existing_1"."week_start") AND ("nr"."status" <> 'cancelled'::"public"."ride_status") AND ("nr"."origin_id" = "existing_1"."destination_id") AND ((("nr"."starts_at" AT TIME ZONE 'Asia/Jerusalem'::"text"))::"date" = (("existing_1"."ends_at" AT TIME ZONE 'Asia/Jerusalem'::"text"))::"date"))
                                  ORDER BY "nr"."starts_at"
                                 LIMIT 1)
                                UNION ALL
                                ( SELECT "pr"."id" AS "ride_id",
                                    "pr"."ends_at" AS "at",
                                    "dp2"."full_name" AS "driver_name",
                                    ( SELECT "p"."full_name"
   FROM (("public"."ride_requests" "rr"
     JOIN "public"."requests" "q" ON (("q"."id" = "rr"."request_id")))
     JOIN "public"."profiles" "p" ON (("p"."id" = "q"."requester_id")))
  WHERE ("rr"."ride_id" = "pr"."id")
  ORDER BY "rr"."created_at"
 LIMIT 1) AS "first_requester"
                                   FROM ("public"."rides" "pr"
                                     LEFT JOIN "public"."profiles" "dp2" ON (("dp2"."id" = "pr"."driver_id")))
                                  WHERE ((EXISTS ( SELECT 1
   FROM "jsonb_array_elements"("existing_1"."served") "e"("value")
  WHERE ((("e"."value" ->> 'role'::"text") = 'driver'::"text") AND (("e"."value" ->> 'car_mode'::"text") = 'relay'::"text") AND (("e"."value" ->> 'leg'::"text") = 'return'::"text")))) AND ("pr"."id" <> "existing_1"."id") AND ("pr"."car_id" = "existing_1"."car_id") AND ("pr"."department_id" = "existing_1"."department_id") AND ("pr"."week_start" = "existing_1"."week_start") AND ("pr"."status" <> 'cancelled'::"public"."ride_status") AND ("pr"."destination_id" = "existing_1"."origin_id") AND ((("pr"."ends_at" AT TIME ZONE 'Asia/Jerusalem'::"text"))::"date" = (("existing_1"."starts_at" AT TIME ZONE 'Asia/Jerusalem'::"text"))::"date"))
                                  ORDER BY "pr"."ends_at" DESC
                                 LIMIT 1)) "x"
                         LIMIT 1) "rp" ON (true))) "existing"
             LEFT JOIN LATERAL ( SELECT "jsonb_agg"(("elem"."value" || "jsonb_build_object"('stops', COALESCE("stop_agg"."stops", '[]'::"jsonb"))) ORDER BY "elem"."ord") AS "served"
                   FROM ("jsonb_array_elements"("existing"."served") WITH ORDINALITY "elem"("value", "ord")
                     LEFT JOIN LATERAL ( SELECT COALESCE("jsonb_agg"("jsonb_build_object"('leg', "e"."leg", 'position', "e"."position", 'place_id', "e"."place_id", 'place_text', "e"."place_text", 'name', COALESCE("d"."name", "e"."place_text"), 'eta', "e"."eta", 'active', "e"."active") ORDER BY "e"."leg", "e"."position"), '[]'::"jsonb") AS "stops"
                           FROM ("public"."request_stops_with_eta"((("elem"."value" ->> 'request_id'::"text"))::"uuid") "e"("leg", "position", "place_id", "place_text", "eta", "active")
                             LEFT JOIN "public"."destinations" "d" ON (("d"."id" = "e"."place_id")))) "stop_agg" ON (true))) "served_stops" ON (true))) "ex";
