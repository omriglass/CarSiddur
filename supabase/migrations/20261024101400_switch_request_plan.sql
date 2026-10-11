-- Owner 2026-10-11 (REQ §13.126 h): the Sadran's direct plan A ⇄ plan B switch. _convert_to_alternative (the conversion
-- part of _apply_alternative, now shared; _apply_alternative calls it), switch_request_plan, and the two outcome_changed
-- notice variants. Full definitions from schema-current.sql where a function changes.

CREATE OR REPLACE FUNCTION "public"."_convert_to_alternative"("p_request_id" "uuid", "p_dep" timestamp with time zone, "p_ret" timestamp with time zone) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
-- REQ §13.112 (a) / owner 2026-10-11: turns a request into its plan-B הקפצה (no placement): the main trip is kept whole in
-- original_main, a pickup from another place becomes a sibling request (returned). Shared by _apply_alternative (an accepted
-- proposal) and switch_request_plan (the Sadran's direct switch). Callers lock the rows and validate first.
declare
  q public.requests%rowtype; a public.request_alternatives%rowtype; v_orig jsonb;
  v_dep timestamptz := p_dep; v_ret timestamptz; v_diff boolean; v_pickup_at timestamptz; v_sib uuid;
begin
  select * into q from public.requests where id = p_request_id;
  select * into a from public.request_alternatives where request_id = p_request_id;
  v_diff := a.pickup and (a.pickup_place_id is not null or a.pickup_place_text is not null);
  v_pickup_at := a.pickup_at;
  v_ret := case when a.pickup and not v_diff then p_ret end;

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
  end if;

  update public.request_alternatives set original_main = v_orig, applied_at = now() where id = a.id;
  return v_sib;
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

  v_sib := public._convert_to_alternative(q.id, v_dep, v_ret);
  if v_diff then v_sib_car := v_ret_car; end if;

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

-- Owner 2026-10-11 (REQ §13.126 h): the Sadran switches a request with a plan B between plan A and plan B directly (board:
-- the waiting-list card and the ride sheet). On a published day the member is told and the new plan is placed on a free car
-- (plan B: else the waiting list; plan A: refused with plan_a_no_car, the member stays on plan B — never left with neither).
-- On an unpublished day the switch is silent and nothing is placed (the Sadran / the solver places it).
create or replace function public.switch_request_plan(p_request_id uuid, p_to text, p_expected_version integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  q public.requests%rowtype; a public.request_alternatives%rowtype; v_actor uuid := (select auth.uid());
  v_day date; v_public boolean; v_dep timestamptz; v_ret timestamptz; v_out int; v_back int; v_sib uuid;
  v_ride uuid; v_car uuid; v_prev text; v_status public.request_status; v_placed boolean := false;
  v_alone boolean; v_prev_supp text := coalesce(current_setting('app.suppress_notifications', true), '');
begin
  if p_to not in ('alternative', 'main') then raise exception 'invalid_plan' using errcode = 'P0001'; end if;
  select * into q from public.requests where id = p_request_id for update;
  if q.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(q.department_id, q.week_start) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if exists (select 1 from public.weeks w where w.department_id = q.department_id and w.week_start = q.week_start and w.phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  if p_expected_version is null or q.version <> p_expected_version then perform public.raise_stale_version(); end if;
  select * into a from public.request_alternatives where request_id = q.id for update;
  if a.id is null or q.fallback <> 'alternative' or q.series_id is not null or q.plan_b_parent_id is not null
     or q.status in ('draft', 'cancelled', 'withdrawn') then
    raise exception 'alternative_not_applicable' using errcode = 'P0001';
  end if;
  v_day := (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date;
  v_public := public.is_day_public(q.department_id, q.week_start, v_day);

  -- Releasing the old plan's rides would tell the member "ride cancelled" right before "switched"; when nobody else rides on
  -- them, those release notices are silenced (others on board still hear about their ride).
  v_alone := not exists (
    select 1 from public.ride_requests rr join public.ride_requests other on other.ride_id = rr.ride_id and other.request_id <> rr.request_id
    join public.rides r on r.id = rr.ride_id
    where rr.request_id in (select q.id union select x.id from public.requests x where x.plan_b_parent_id = q.id) and r.status <> 'cancelled')
    and not exists (
    select 1 from public.ride_requests rr join public.ride_passengers rp on rp.ride_id = rr.ride_id join public.rides r on r.id = rr.ride_id
    where rr.request_id = q.id and r.status <> 'cancelled');
  v_prev := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
  perform set_config('app.system_status_transition', 'on', true);
  perform set_config('app.audit_reason', 'switch_request_plan', true);

  if p_to = 'alternative' then
    if q.served_by_alternative or a.applied_at is not null then raise exception 'alternative_not_applicable' using errcode = 'P0001'; end if;
    if q.trip_type not in ('round_trip', 'one_way') and not (q.trip_type = 'drop_off' and q.keep_car_at_destination) then
      raise exception 'alternative_not_applicable' using errcode = 'P0001';
    end if;
    -- times: be at the drop place by arrive_by (leave = arrive_by - the drive, quarter hour down); the pickup ride ends home
    v_out := coalesce((select pt.travel_minutes from public.place_travel(q.origin_id, a.drop_place_id) pt), 60);
    v_dep := to_timestamp(floor(extract(epoch from (a.arrive_by - make_interval(mins => v_out))) / 900) * 900);
    if a.pickup then
      v_back := coalesce((select pt.travel_minutes from public.place_travel(coalesce(a.pickup_place_id, a.drop_place_id), q.origin_id) pt), 60);
      v_ret := to_timestamp(ceil(extract(epoch from (a.pickup_at + make_interval(mins => v_back))) / 900) * 900);
    end if;
    if v_alone then perform set_config('app.suppress_notifications', 'on', true); end if;
    perform public.release_request_booking(q.id);
    perform set_config('app.suppress_notifications', v_prev_supp, true);
    -- the release may cancel plan A's ride and reset the system-transition flag; the conversion is a system step
    perform set_config('app.system_status_transition', 'on', true);
    v_sib := public._convert_to_alternative(q.id, v_dep, v_ret);
    perform set_config('app.system_status_transition', 'on', true);
    if v_public then
      v_ride := public.place_request_on_any_free_car(q.id, v_actor, v_dep, case when a.pickup and v_sib is null then v_ret end, 'PLAN_B_SWITCH');
      if v_sib is not null then
        perform public.place_request_on_any_free_car(v_sib, v_actor, a.pickup_at, null, 'PLAN_B_SWITCH');
      end if;
      if v_ride is null then
        update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_NO_CAR' where id = q.id;
      end if;
      perform public.enqueue_notification(q.requester_id, 'outcome_changed', q.department_id, q.week_start, '{}'::jsonb,
        jsonb_build_object('variant', 'plan_b_switched', 'request_id', q.id), format('plan_b_switched:%s:%s', q.id, clock_timestamp()));
    end if;
  else
    if not q.served_by_alternative then raise exception 'alternative_not_applied' using errcode = 'P0001'; end if;
    if v_alone then perform set_config('app.suppress_notifications', 'on', true); end if;
    perform public._restore_original_main(q.id);   -- releases plan B (and its sibling), the request is plan A again
    perform set_config('app.suppress_notifications', v_prev_supp, true);
    perform set_config('app.system_status_transition', 'on', true);
    select * into q from public.requests where id = q.id;
    if v_public then
      if q.trip_type = 'drop_off' and q.keep_car_at_destination then
        for v_car in
          select c.id from public.cars c where c.department_id = q.department_id and c.status = 'active' and c.type = 'shared' order by c.id
        loop
          begin
            v_ride := public.place_request_on_car(q.id, v_car, true, v_actor, null, null, null, 'PLAN_A_RESTORED');
            if coalesce(array_length(public.request_covered_legs(q.id), 1), 0) < 2 then
              raise exception 'keep_car_both_legs' using errcode = 'PXKC1';
            end if;
            v_placed := true;
            exit;
          exception when others then v_ride := null;
          end;
        end loop;
      else
        v_ride := public.place_request_on_any_free_car(q.id, v_actor, null, null, 'PLAN_A_RESTORED');
        v_placed := v_ride is not null;
      end if;
      -- on a published day the member is never left without either plan
      if not v_placed then raise exception 'plan_a_no_car' using errcode = 'P0001'; end if;
      perform public.enqueue_notification(q.requester_id, 'outcome_changed', q.department_id, q.week_start, '{}'::jsonb,
        jsonb_build_object('variant', 'plan_a_restored', 'request_id', q.id), format('plan_a_restored:%s:%s', q.id, clock_timestamp()));
    end if;
  end if;

  perform set_config('app.system_status_transition', v_prev, true);
  select status into v_status from public.requests where id = q.id;
  return jsonb_strip_nulls(jsonb_build_object('status', v_status, 'ride_id', v_ride, 'plan', p_to, 'notified', v_public));
end $$;

revoke all on function public.switch_request_plan(uuid, text, integer) from public;
grant execute on function public.switch_request_plan(uuid, text, integer) to authenticated;
grant execute on function public.switch_request_plan(uuid, text, integer) to service_role;

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'outcome_changed', ch, t.variant, t.title, t.body, t.title, t.body
from (values
  ('plan_b_switched', 'עברת לתוכנית ב׳', 'אין רכב לנסיעה המקורית שלך ביום {{day}}, אז הסידור עבר לתוכנית ב׳ שלך: {{route}}.'),
  ('plan_a_restored', 'חזרת לנסיעה המקורית', 'נמצא רכב — הנסיעה המקורית שלך ביום {{day}} חזרה: {{route}}.')
) as t(variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do nothing;

revoke all on function public._convert_to_alternative(uuid, timestamptz, timestamptz) from public;
grant execute on function public._convert_to_alternative(uuid, timestamptz, timestamptz) to service_role;
