-- REQ §13.112 (a)/(b): helpers behind submit_request's `fallback` / `alternative` payload keys. Internal (no grants).
--
-- _request_fallback_from_payload(payload, current): the fallback a submit stores. No `fallback` key keeps the stored
-- value (a plan B object without the key implies 'alternative'); an unknown token is refused.
create or replace function public._request_fallback_from_payload(p_payload jsonb, p_current public.request_fallback)
returns public.request_fallback
language plpgsql immutable set search_path = public, pg_temp as $$
declare v_token text;
begin
  if p_payload ? 'fallback' then
    v_token := coalesce(nullif(p_payload ->> 'fallback', ''), 'none');
    if v_token not in ('none', 'alternative', 'manage') then
      raise exception 'invalid_fallback' using errcode = 'P0001';
    end if;
    return v_token::public.request_fallback;
  end if;
  if jsonb_typeof(p_payload -> 'alternative') = 'object' then return 'alternative'; end if;
  return coalesce(p_current, 'none');
end $$;
revoke all on function public._request_fallback_from_payload(jsonb, public.request_fallback) from public, anon, authenticated;

-- _save_request_alternative(request, payload, old depart): after submit_request wrote the request row, validates and
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
    insert into public.request_alternatives (request_id, department_id, week_start, drop_place_id, drop_place_text,
      arrive_by, pickup, pickup_at)
    values (q.id, q.department_id, q.week_start, v_place, v_text, v_arrive, v_pickup, v_pickup_at)
    on conflict (request_id) do update set drop_place_id = excluded.drop_place_id, drop_place_text = excluded.drop_place_text,
      arrive_by = excluded.arrive_by, pickup = excluded.pickup, pickup_at = excluded.pickup_at;
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
