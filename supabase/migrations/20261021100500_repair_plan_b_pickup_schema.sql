-- Repair (2026-10-09, release v2026.10.09-1): production recorded migrations 20261019110000,
-- 20261019110100 and 20261019110200 (plan-B pickup from a different place) as applied, but their
-- contents never ran there — the pickup columns, `requests.plan_b_parent_id`, the pair-cascade
-- trigger and the newer plan-B functions were missing, so every request read embedding
-- `destinations!request_alternatives_pickup_place_fk` failed (PGRST200: /my, siddur, board,
-- request form). This migration re-applies exactly that state, idempotently: on a database that
-- already has it (local, CI replay) it changes nothing. Function bodies are the current
-- definitions (supabase/schema-current.sql), not the 20261019110x originals, because later
-- migrations redefined some of them.

alter table public.request_alternatives
  add column if not exists pickup_place_id uuid,
  add column if not exists pickup_place_text text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'request_alternatives_pickup_place_ck') then
    alter table public.request_alternatives add constraint request_alternatives_pickup_place_ck check (
      (pickup_place_id is null or pickup_place_text is null)
      and (pickup or (pickup_place_id is null and pickup_place_text is null)));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'request_alternatives_pickup_place_fk') then
    alter table public.request_alternatives add constraint request_alternatives_pickup_place_fk
      foreign key (department_id, pickup_place_id) references public.destinations (department_id, id);
  end if;
end $$;

alter table public.requests add column if not exists plan_b_parent_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'requests_plan_b_parent_id_fkey') then
    alter table public.requests add constraint requests_plan_b_parent_id_fkey
      foreign key (plan_b_parent_id) references public.requests(id) on delete cascade;
  end if;
end $$;

create index if not exists requests_plan_b_parent_idx on public.requests (plan_b_parent_id) where plan_b_parent_id is not null;

CREATE OR REPLACE FUNCTION "public"."_alternative_vars"("p_payload" "jsonb", "p_department_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
     or q.trip_type not in ('round_trip', 'one_way') or q.series_id is not null
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
    'stops', coalesce((select jsonb_agg(jsonb_build_object('leg', s.leg, 'position', s."position",
        'place_id', s.place_id, 'place_text', s.place_text) order by s.leg, s."position")
      from public.request_stops s where s.request_id = q.id), '[]'::jsonb));

  perform set_config('app.request_anchors_explicit', 'on', true);
  perform set_config('app.duration_lock_explicit', 'on', true);
  update public.requests set
    trip_type = 'drop_off',
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


CREATE OR REPLACE FUNCTION "public"."_plan_b_pair_cascade"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare s record; v_prev text;
begin
  for s in select id from public.requests
           where status not in ('withdrawn', 'cancelled') and (plan_b_parent_id = new.id or id = new.plan_b_parent_id)
           order by id for update loop
    v_prev := coalesce(current_setting('app.system_status_transition', true), 'off');
    perform public.release_request_booking(s.id);
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = new.status, status_reason = 'PLAN_B_PAIR' where id = s.id;
    perform set_config('app.system_status_transition', v_prev, true);
  end loop;
  return null;
end $$;


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


CREATE OR REPLACE FUNCTION "public"."fairness_stats"("p_department_id" "uuid", "p_week_start" "date", "p_lookback_weeks" integer) RETURNS TABLE("profile_id" "uuid", "granted_hours" numeric)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_alt numeric;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode='P0001';
  end if;
  v_alt := public.alternative_served_weight(p_department_id);

  return query
    select p.id,
      coalesce(sum(
        coalesce(
          extract(epoch from (q.return_at - q.depart_at)) / 3600.0,
          (select sum(extract(epoch from (r.ends_at-r.starts_at)) / 3600.0)
           from public.ride_requests rr join public.rides r on r.id=rr.ride_id
           where rr.request_id=q.id and r.status<>'cancelled')
        ) * case when q.plan_b_parent_id is not null then 0 when q.served_by_alternative then v_alt else 1 end
      ) filter (where q.status in ('assigned','merged')), 0)::numeric as granted_hours
    from public.department_members dm
    join public.profiles p on p.id=dm.profile_id
    left join public.requests q on q.requester_id=p.id and q.department_id=p_department_id
      and q.week_start >= p_week_start-(p_lookback_weeks*7) and q.week_start<p_week_start
    where dm.department_id=p_department_id and dm.removed_at is null
    group by p.id;
end;
$$;

ALTER FUNCTION "public"."_plan_b_pair_cascade"() OWNER TO "postgres";
revoke all on function public._plan_b_pair_cascade() from public, anon, authenticated;
grant all on function public._plan_b_pair_cascade() to service_role;

drop trigger if exists requests_plan_b_pair_cascade on public.requests;
create trigger requests_plan_b_pair_cascade after update of status on public.requests
  for each row when (new.status in ('withdrawn', 'cancelled') and old.status is distinct from new.status)
  execute function public._plan_b_pair_cascade();

-- PostgREST: pick up the new relationship without waiting for the next schema reload.
notify pgrst, 'reload schema';
