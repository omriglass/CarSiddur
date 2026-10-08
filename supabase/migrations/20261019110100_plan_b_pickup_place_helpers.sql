-- REQ §13.112 (a): pickup from a place other than the drop place -- helpers (full create-or-replace of the three functions of
-- 20261019100400 / 100550 / 100700 with the pickup place). Fragment `alt.pickup_from` names it.
insert into public.text_fragments (key, body) values
  ('alt.pickup_from', ', ואיסוף מ{{pickupPlace}} ב־{{pickupTime}}')
on conflict (key) do update set body = excluded.body, updated_at = now();

-- (20261019110100: also stores `pickup_place_id` / `pickup_place_text`, REQ §13.112 a) _save_request_alternative(request, payload, old depart): after submit_request wrote the request row, validates and
-- stores (or removes, `alternative: null`) its plan B, and moves a stored plan B along when the main trip's day moved
-- (the classic form sends no plan-B keys but may change the day). Rules (REQ §13.112 a):
--   * only a הלוך-חזור / הלוך בלבד request that is not a multi-day series carries an active fallback; an explicit
--     `fallback` other than 'none' (or a plan B object) on anything else is refused with `fallback_not_allowed`.
--     A stored plan B whose request later becomes a הקפצה is kept, inactive (REQ §13.97: nothing is deleted).
--   * the drop place is a list place of the department or free text, never the request's own origin; `arrive_by` and
--     `pickup_at` sit on the quarter-hour grid on the main trip's Jerusalem day; a pickup comes after the arrival.
--   * fallback 'alternative' needs a plan B (in the payload or stored).
create or replace function public._save_request_alternative(p_request_id uuid, p_payload jsonb, p_old_depart timestamptz)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
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

  if v_explicit and (q.trip_type not in ('round_trip', 'one_way') or q.series_id is not null) then
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
revoke all on function public._save_request_alternative(uuid, jsonb, timestamptz) from public, anon, authenticated;

-- (20261019110100: pickup from another place) _validate_alternative_payload(request, payload): create_proposal's check for an `alternative` draft. Returns the payload
-- completed with the plan B read from the request's own row (the row, not the caller, is the source of the places and
-- times). Refusals: `alternative_not_applicable` (the request has no plan B, is already served by one, is not an
-- unmet הלוך-חזור / הלוך בלבד request), `alternative_payload_invalid` (cars/times).
create or replace function public._validate_alternative_payload(p_request_id uuid, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
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
revoke all on function public._validate_alternative_payload(uuid, jsonb) from public, anon, authenticated;

-- The variables every plan-B text uses, from a payload that carries the plan (see _validate_alternative_payload).
create or replace function public._alternative_vars(p_payload jsonb, p_department_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_place text; v_drop text; v_pickup text := ''; v_pp text;
begin
  select d.name into v_place from public.destinations d
    where d.id = nullif(p_payload ->> 'drop_place_id', '')::uuid and d.department_id = p_department_id;
  v_place := coalesce(v_place, nullif(p_payload ->> 'drop_place_text', ''), '');
  v_drop := coalesce(public._hhmm(nullif(p_payload ->> 'arrive_by', '')::timestamptz), '');
  if coalesce((p_payload ->> 'pickup')::boolean, false) then
    select d.name into v_pp from public.destinations d
      where d.id = nullif(p_payload ->> 'pickup_place_id', '')::uuid and d.department_id = p_department_id;
    v_pp := coalesce(v_pp, nullif(p_payload ->> 'pickup_place_text', ''));
    v_pickup := public._frag(case when v_pp is null then 'alt.pickup' else 'alt.pickup_from' end, jsonb_build_object('pickupTime',
      coalesce(public._hhmm(nullif(p_payload ->> 'pickup_at', '')::timestamptz), ''), 'pickupPlace', coalesce(v_pp, '')));
  end if;
  return jsonb_build_object('dropPlace', v_place, 'dropTime', v_drop, 'pickupLine', v_pickup,
    'planLine', public._frag('alt.plan', jsonb_build_object('dropPlace', v_place, 'dropTime', v_drop, 'pickupLine', v_pickup)));
end $$;
revoke all on function public._alternative_vars(jsonb, uuid) from public, anon, authenticated;

