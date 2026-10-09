-- Pilot fix round P2 (docs/PILOT_FIX_ROUND_2026-10.md; REQ §13.117).
-- R8B13: ONE chauffeur-ride duration rule on both sides: ceil((route + direct + dwell) / 15) * 15 minutes, rounded once
--   from exact minutes (route = the leg's own route minutes, stops included; direct = the empty drive origin <-> destination;
--   equal to route with no stops). The solver (chauffeurTotalSlots in src/solver/travel.ts) and the hand placement now agree
--   (QA run 8: hand 09:30-10:45, solver 09:30-11:15 for the same 31-minute drop-off).
-- R8B12: set_request_trip_type places a request that had no car on any free shared car (new internal helper
--   place_request_on_any_free_car; no grants, called from definer functions only).
-- Full create or replace of the three functions from their current definitions; place_request_on_car changes only the v_dur line.

CREATE OR REPLACE FUNCTION public.chauffeur_ride_minutes(p_request_id uuid, p_leg public.ride_leg) RETURNS integer
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare q public.requests%rowtype; v_dwell int; v_travel int; v_direct int;
begin
  select * into q from public.requests where id = p_request_id;
  if q.id is null then return null; end if;
  select coalesce((w.settings_overrides ->> 'chauffeur_dwell_minutes')::int, s.chauffeur_dwell_minutes, 10) into v_dwell
  from public.department_settings s left join public.weeks w on w.department_id = s.department_id and w.week_start = q.week_start
  where s.department_id = q.department_id;
  v_dwell := coalesce(v_dwell, 10);
  v_travel := greatest(coalesce(public.request_leg_route_minutes(q.id, p_leg), 30), 0);
  v_direct := v_travel;
  if q.origin_id is not null and q.destination_id is not null then
    select greatest(coalesce(p.travel_minutes, 60), 0) into v_direct from public.place_travel(q.origin_id, q.destination_id) p;
    v_direct := coalesce(v_direct, v_travel);
  end if;
  return greatest(15, ceil((v_travel + v_direct + greatest(v_dwell, 0)) / 15.0)::int * 15);
end $function$;

CREATE OR REPLACE FUNCTION public.place_request_on_any_free_car(p_request_id uuid, p_actor uuid, p_dep timestamptz, p_ret timestamptz, p_reason text) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  q public.requests%rowtype; v_car uuid; v_ride uuid; v_first uuid; v_prev text;
begin
  select * into q from public.requests where id = p_request_id;
  if q.id is null then return null; end if;
  -- First car (the member's preferred one first, then by id) that takes at least one leg under the ordinary rules
  -- (turnaround buffer, car at the leg's place, seats, maintenance). A failed attempt rolls back with its subtransaction.
  for v_car in
    select c.id from public.cars c
    where c.department_id = q.department_id and c.status = 'active' and c.type = 'shared'
    order by (c.id = q.preferred_car_id) desc, c.id
  loop
    begin
      v_ride := public.place_request_on_car(p_request_id, v_car, false, p_actor, null, p_dep, p_ret, p_reason);
      v_first := v_ride;
      exit;
    exception when others then
      v_ride := null;
    end;
  end loop;
  if v_first is null then return null; end if;

  -- A drop-off places each leg on its own; one leg may be left over -> offer the missing leg to the other cars.
  if (select r.status_reason from public.requests r where r.id = p_request_id) like '%\_PARTIAL' then
    v_prev := coalesce(current_setting('app.place_only_missing', true), '');
    perform set_config('app.place_only_missing', 'on', true);
    for v_car in
      select c.id from public.cars c
      where c.department_id = q.department_id and c.status = 'active' and c.type = 'shared'
      order by c.id
    loop
      begin
        perform public.place_request_on_car(p_request_id, v_car, false, p_actor, null, p_dep, p_ret, p_reason);
        exit;
      exception when others then
        null;
      end;
    end loop;
    perform set_config('app.place_only_missing', v_prev, true);
  end if;
  return v_first;
end $function$;

CREATE OR REPLACE FUNCTION public.place_request_on_car(p_request_id uuid, p_car_id uuid, p_manual boolean, p_actor uuid, p_named_driver uuid, p_dep timestamp with time zone, p_ret timestamp with time zone, p_reason text DEFAULT 'PROPOSAL_APPLIED'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  q public.requests%rowtype; v_home uuid;
  v_car uuid; v_dep timestamptz; v_ret timestamptz; v_manual boolean; v_public boolean;
  v_named uuid; v_driver uuid; v_old record; v_old_cars uuid[] := '{}'; v_old_car uuid;
  v_ride uuid; v_first uuid; v_rides uuid[] := '{}'; v_end timestamptz;
  v_travel int; v_dur int; v_dwell int; v_gap smallint; v_buffer int;
  v_week_from timestamptz; v_week_until timestamptz; v_day date;
  v_leg public.ride_leg; v_at timestamptz; v_legs int := 0; v_wanted int := 0;
  v_s timestamptz; v_e timestamptz; v_loc uuid; v_ok boolean; k int; c int; v_rid uuid;
  v_relay boolean; v_pickup_driver uuid; v_needs_driver boolean := false;
begin
  select * into q from public.requests where id = p_request_id for update;
  if q.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  v_car := p_car_id;
  if not exists(select 1 from public.cars where id = v_car and department_id = q.department_id and status = 'active') then
    raise exception 'shift_car_invalid' using errcode = 'P0001';
  end if;
  -- REQ §13.99: only the owner puts requests on a private car (the owner's own request on it is fine).
  perform public.assert_private_car_owner_only(v_car, p_actor, q.requester_id);
  v_manual := coalesce(p_manual, false);
  v_public := public.is_week_public(q.department_id, q.week_start);
  v_dep := case when q.trip_shape = 'one_way_from' then null else coalesce(p_dep, q.depart_at) end;
  v_ret := case when q.trip_type = 'one_way' or q.trip_shape = 'one_way_to' then null
                else coalesce(p_ret, q.return_at) end;
  if v_dep is null and v_ret is null then raise exception 'shift_car_invalid' using errcode = 'P0001'; end if;
  if v_dep is distinct from q.depart_at or v_ret is distinct from q.return_at then
    update public.requests set depart_at = v_dep, return_at = v_ret where id = q.id;
  end if;
  select * into q from public.requests where id = q.id;
  v_day := (coalesce(v_dep, v_ret) at time zone 'Asia/Jerusalem')::date;
  v_week_from := q.week_start::timestamp at time zone 'Asia/Jerusalem';
  v_week_until := (q.week_start + 7)::timestamp at time zone 'Asia/Jerusalem';
  v_buffer := coalesce(public.required_turnaround_minutes(q.department_id, q.week_start), 30);

  -- Replace the request's previous placement.
  for v_old in select rd.* from public.rides rd join public.ride_requests rr on rr.ride_id = rd.id
    where rr.request_id = q.id and rd.status <> 'cancelled' order by rd.id for update of rd loop
    continue when coalesce(current_setting('app.place_only_missing', true), 'off') = 'on'   -- R2B3: keep legs already served
      or coalesce(current_setting('app.place_only_leg', true), '') in ('out', 'return');   -- R4B4: the other leg stays
    if exists(select 1 from public.ride_requests where ride_id = v_old.id and request_id <> q.id) then
      if not v_manual then raise exception 'shared_ride_requires_sadran'; end if;
    else
      update public.rides set status = 'cancelled', cancelled_at = now(),
        cancelled_by = coalesce(p_actor, q.requester_id), cancel_reason = 'REPLACED_BY_PROPOSAL' where id = v_old.id;
    end if;
    delete from public.ride_requests where ride_id = v_old.id and request_id = q.id;
    v_old_cars := v_old_cars || v_old.car_id;
  end loop;

  if q.trip_type = 'round_trip' then
    -- REQ §13.95 H3: a round trip is one ride, the requester (or a driving companion) drives, car kept.
    v_driver := public.eligible_leg_driver(q.id);
    if v_driver is null then raise exception 'non_driver_needs_drop_off' using errcode = 'P0001'; end if;
    if v_dep is null or v_ret is null then raise exception 'shift_car_invalid' using errcode = 'P0001'; end if;
    select home_destination_id into v_home from public.departments where id = q.department_id;
    v_loc := coalesce(q.origin_id, v_home);
    -- R6B4 (REQ §13.93): the same rule as every other placement -- a shared car is used only where it stands, and
    -- the round trip must leave it where the car's next ride expects it (else the caller keeps the request unmet).
    if exists(select 1 from public.cars where id = v_car and type = 'shared') then
      if public.car_location_at(v_car, v_dep) is distinct from v_loc then
        raise exception 'car_not_at_leg_origin' using errcode = 'P0001';
      end if;
      if coalesce(public.car_next_ride_origin(v_car, v_ret), v_loc) <> v_loc then
        raise exception 'car_next_ride_elsewhere' using errcode = 'P0001';
      end if;
    end if;
    v_gap := null;
    if v_manual then v_gap := public.prepare_manual_ride_window(v_car, q.week_start, v_dep, v_ret, null); end if;
    insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id,
      status, is_pinned, pin_reason, created_by, turnaround_override_minutes)
    values(q.department_id, q.week_start, v_car, v_dep, v_ret, v_loc, v_loc, v_driver,
      case when v_public then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
      true, p_reason, p_actor, v_gap) returning id into v_ride;
    insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values(v_ride, q.id, 'driver', 'both', 'keep');
    v_first := v_ride; v_rides := array[v_ride];
    update public.requests set status = 'assigned', status_reason = p_reason where id = q.id;
  elsif q.trip_type = 'one_way' then
    if q.origin_id is null or q.destination_id is null then raise exception 'shift_car_invalid' using errcode = 'P0001'; end if;
    v_driver := public.eligible_leg_driver(q.id);
    if v_driver is null then raise exception 'no_eligible_driver' using errcode = 'P0001'; end if;
    v_travel := greatest(coalesce(public.request_leg_route_minutes(q.id, 'out'), 30), 0);
    v_end := greatest(public._round_up_ride_end(v_dep, v_dep + make_interval(mins => v_travel)), v_dep + interval '15 minutes');
    if public.car_location_at(v_car, v_dep) is distinct from q.origin_id then
      raise exception 'car_not_at_leg_origin' using errcode = 'P0001';
    end if;
    if coalesce(public.car_next_ride_origin(v_car, v_end), q.destination_id) <> q.destination_id then
      raise exception 'car_next_ride_elsewhere' using errcode = 'P0001';
    end if;
    v_gap := null;
    if v_manual then v_gap := public.prepare_manual_ride_window(v_car, q.week_start, v_dep, v_end, null); end if;
    insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id,
      status, is_pinned, pin_reason, created_by, turnaround_override_minutes)
    values(q.department_id, q.week_start, v_car, v_dep, v_end, q.origin_id, q.destination_id, v_driver,
      case when v_public then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
      true, p_reason, p_actor, v_gap) returning id into v_ride;
    insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values(v_ride, q.id, 'driver', 'out', 'relay');
    v_first := v_ride; v_rides := array[v_ride];
    update public.requests set status = 'assigned', status_reason = p_reason where id = q.id;
  else
    -- drop_off: one chauffeur ride per leg.
    v_named := p_named_driver;
    if v_named is not null and not exists(select 1 from public.department_members
      where department_id = q.department_id and profile_id = v_named and removed_at is null) then
      raise exception 'shift_car_invalid' using errcode = 'P0001';
    end if;
    select coalesce((w.settings_overrides ->> 'chauffeur_dwell_minutes')::int, s.chauffeur_dwell_minutes, 10) into v_dwell
    from public.department_settings s join public.weeks w on w.department_id = s.department_id and w.week_start = q.week_start
    where s.department_id = q.department_id;
    v_dwell := coalesce(v_dwell, 10);
    for k in 1..2 loop
      if k = 1 then v_leg := 'out'; v_at := v_dep; else v_leg := 'return'; v_at := v_ret; end if;
      continue when v_at is null;
      continue when coalesce(current_setting('app.place_only_leg', true), '') in ('out', 'return')   -- R4B4: a single-leg shift places only that leg
        and v_leg::text <> current_setting('app.place_only_leg', true);
      continue when coalesce(current_setting('app.place_only_missing', true), 'off') = 'on' and v_leg::text = any(public.request_covered_legs(q.id));
      v_wanted := v_wanted + 1;
      v_travel := greatest(coalesce(public.request_leg_route_minutes(q.id, v_leg), 30), 0);
      v_dur := public.chauffeur_ride_minutes(q.id, v_leg);   -- R8B13: the one chauffeur-duration rule (same as the solver)
      v_ok := false; v_relay := false; v_pickup_driver := null;
      -- REQ §13.105 b (QA run 5 R5Q2): a pickup from X on a car already standing at X, driven home by the requester
      -- (or a driving companion) -- candidate 0, before the chauffeur wraps. Not when the Sadran named a volunteer.
      if v_leg = 'return' and v_named is null and q.origin_id is not null and q.destination_id is not null
         and q.origin_id <> q.destination_id then
        v_pickup_driver := public.eligible_leg_driver(q.id);
      end if;
      for c in 0..2 loop
        continue when c = 0 and v_pickup_driver is null;
        continue when c = 2 and v_leg <> 'out';
        if c = 0 then
          v_loc := q.destination_id; v_relay := true;
          v_e := v_at; v_s := v_e - make_interval(mins => greatest(15, ceil(v_travel / 15.0)::int * 15));
        elsif c = 1 then
          v_relay := false;
          v_loc := q.origin_id;
          if v_leg = 'out' then v_s := v_at; v_e := v_at + make_interval(mins => v_dur);
          else v_e := v_at; v_s := v_at - make_interval(mins => v_dur); end if;
        else
          v_relay := false;
          v_loc := q.destination_id;
          v_e := v_at + make_interval(mins => ceil(v_travel / 15.0)::int * 15); v_s := v_e - make_interval(mins => v_dur);
        end if;
        continue when v_loc is null or v_s < v_week_from or v_e > v_week_until
          or (v_s at time zone 'Asia/Jerusalem')::date <> v_day
          or ((v_e - interval '1 minute') at time zone 'Asia/Jerusalem')::date <> v_day
          or public.car_location_at(v_car, v_s) is distinct from v_loc
          or exists(select 1 from public.rides r where r.car_id = v_car and r.status <> 'cancelled'
            and tstzrange(r.starts_at, case when v_manual then r.ends_at else r.blocked_until end, '[)')
              && tstzrange(v_s, case when v_manual then v_e else v_e + make_interval(mins => v_buffer) end, '[)'))
          or exists(select 1 from public.car_maintenance_blocks b where b.car_id = v_car
            and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_s, v_e, '[)'))
          or (c = 0 and (not public.car_fits(v_car, q.adults, q.child_seats, q.boosters)
            or coalesce(public.car_next_ride_origin(v_car, v_e), q.origin_id) <> q.origin_id));
        v_ok := true; exit;
      end loop;
      continue when not v_ok;
      v_gap := null;
      if v_manual then v_gap := public.prepare_manual_ride_window(v_car, q.week_start, v_s, v_e, null); end if;
      if v_relay then
        insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id,
          status, is_pinned, pin_reason, created_by, turnaround_override_minutes)
        values(q.department_id, q.week_start, v_car, v_s, v_e, q.destination_id, q.origin_id, v_pickup_driver,
          case when v_public then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
          true, p_reason, p_actor, v_gap)
        returning id into v_ride;
        insert into public.ride_requests(ride_id, request_id, role, leg, car_mode)
        values(v_ride, q.id, case when v_pickup_driver = q.requester_id then 'driver' else 'passenger' end::public.ride_role, 'return', 'relay');
        v_legs := v_legs + 1; v_rides := v_rides || v_ride;
        v_first := coalesce(v_first, v_ride);
        continue;
      end if;
      v_needs_driver := v_needs_driver or v_named is null;
      insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, needs_driver,
        status, is_pinned, pin_reason, created_by, turnaround_override_minutes)
      values(q.department_id, q.week_start, v_car, v_s, v_e, v_loc, v_loc, v_named, v_named is null,
        case when v_public then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
        true, case when v_named is null then 'MISSING_DRIVER' else p_reason end, p_actor, v_gap)
      returning id into v_ride;
      insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values(v_ride, q.id, 'passenger', v_leg, 'chauffeur');
      v_legs := v_legs + 1; v_rides := v_rides || v_ride;
      v_first := coalesce(v_first, v_ride);
    end loop;
    if v_legs = 0 then raise exception 'car_not_at_leg_place' using errcode = 'P0001'; end if;
    if v_named is null and v_needs_driver then
      update public.requests set status = 'waitlisted', status_reason = 'UNMET_NEEDS_DRIVER' where id = q.id;
    else
      update public.requests set status = 'assigned',
        status_reason = case when v_legs < v_wanted then p_reason || '_PARTIAL' else p_reason end where id = q.id;
    end if;
  end if;

  foreach v_rid in array v_rides loop
    perform public.assert_ride_request_day(v_rid);
    perform public.assert_ride_seats_fit(v_rid);
    perform public.assert_ride_driver(v_rid);
  end loop;
  perform public.assert_car_chain(v_car, q.week_start);
  foreach v_old_car in array v_old_cars loop
    if v_old_car <> v_car then perform public.assert_car_chain(v_old_car, q.week_start); end if;
  end loop;
  return v_first;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_request_trip_type(p_request_id uuid, p_trip_type trip_type, p_expected_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  q public.requests%rowtype; v_actor uuid := (select auth.uid());
  v_shape public.trip_shape; v_needs boolean; v_mode public.leg_car_mode; v_dep timestamptz; v_ret timestamptz;
  v_car uuid; v_ride uuid; v_old record; v_old_cars uuid[] := '{}'; v_old_car uuid; v_prev_sys text;
  v_status public.request_status; v_placed boolean := false; v_driver_mode public.leg_car_mode;
  v_kept timestamptz; v_defaulted timestamptz; v_flex_any boolean := false;
begin
  select * into q from public.requests where id = p_request_id for update;
  if q.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(q.department_id, q.week_start) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if exists (select 1 from public.weeks w where w.department_id = q.department_id and w.week_start = q.week_start and w.phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  if p_expected_version is null or q.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if q.series_id is not null then raise exception 'series_edit_not_supported' using errcode = 'MDR02'; end if;
  if q.status in ('draft', 'cancelled', 'withdrawn', 'denied', 'external') then
    raise exception 'request_not_editable' using errcode = 'P0001';
  end if;
  if q.trip_type = p_trip_type then
    return jsonb_build_object('status', q.status, 'changed', false);
  end if;

  select case when p.does_not_drive then 'passenger'::public.leg_car_mode else 'relay'::public.leg_car_mode end into v_driver_mode
  from public.profiles p where p.id = q.requester_id;

  v_dep := q.depart_at; v_ret := q.return_at; v_kept := q.kept_return_at;
  if p_trip_type = 'round_trip' then
    v_ret := coalesce(v_ret, q.kept_return_at); v_kept := null;
    if v_dep is null then raise exception 'trip_type_needs_return' using errcode = 'P0001'; end if;
    -- REQ §13.98: no known return time -> about two hours after arrival (departure + the out
    -- route + 2h, nearest quarter hour, never past the day's end) with return flexibility "any
    -- time that day", so the Sadran can move it without asking anyone.
    if v_ret is null then
      v_ret := to_timestamp(round(extract(epoch from
        v_dep + make_interval(mins => coalesce(public.request_leg_route_minutes(q.id, 'out'), 30)) + interval '2 hours') / 900) * 900);
      if (v_ret at time zone 'Asia/Jerusalem')::date <> (v_dep at time zone 'Asia/Jerusalem')::date then
        v_ret := (((v_dep at time zone 'Asia/Jerusalem')::date + time '23:59') at time zone 'Asia/Jerusalem');
      end if;
      if v_ret <= v_dep then raise exception 'trip_type_needs_return' using errcode = 'P0001'; end if;
      v_defaulted := v_ret; v_flex_any := true;
    end if;
    v_shape := 'round_trip'; v_needs := true; v_mode := null;
  elsif p_trip_type = 'one_way' then
    v_kept := coalesce(v_ret, q.kept_return_at); v_dep := coalesce(v_dep, v_ret); v_ret := null;
    v_shape := 'one_way_to'; v_needs := true; v_mode := 'relay';
  else
    v_needs := false;
    if v_ret is not null then v_kept := null; end if;
    if v_ret is not null and v_dep is not null then v_shape := 'round_trip'; v_mode := null;
    elsif v_ret is not null then v_shape := 'one_way_from'; v_mode := coalesce(q.one_way_car_mode, v_driver_mode);
    else v_shape := 'one_way_to'; v_mode := coalesce(q.one_way_car_mode, v_driver_mode);
    end if;
  end if;
  if p_trip_type <> 'drop_off' and public.eligible_leg_driver(q.id) is null then
    raise exception 'non_driver_needs_drop_off' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'set_request_trip_type', true);
  v_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
  perform set_config('app.system_status_transition', 'on', true);

  update public.requests set trip_type = p_trip_type, trip_shape = v_shape, needs_car_at_destination = v_needs,
    one_way_car_mode = v_mode, depart_at = v_dep, return_at = v_ret, kept_return_at = v_kept,
    flex_return_early = case when v_flex_any then interval '1 day' else flex_return_early end,
    flex_return_late = case when v_flex_any then interval '1 day' else flex_return_late end
  where id = q.id;
  -- REQ §13.97: return-leg stops are kept (inactive while there is no return), never deleted.

  -- Re-place on the car the request was on (earliest live ride).
  select r.car_id into v_car from public.rides r join public.ride_requests rr on rr.ride_id = r.id
  where rr.request_id = q.id and r.status <> 'cancelled' order by r.starts_at, r.id limit 1;
  if v_car is not null then
    begin
      v_ride := public.place_request_on_car(q.id, v_car, true, v_actor, null, v_dep, v_ret, 'TRIP_TYPE_CHANGED');
      v_placed := true;
    exception when sqlstate 'P0001' or sqlstate '23P01' or sqlstate '23514' then
      v_placed := false; v_ride := null;
    end;
    if not v_placed then
      for v_old in select rd.* from public.rides rd join public.ride_requests rr on rr.ride_id = rd.id
        where rr.request_id = q.id and rd.status <> 'cancelled' order by rd.id for update of rd loop
        if not exists (select 1 from public.ride_requests where ride_id = v_old.id and request_id <> q.id) then
          update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = coalesce(v_actor, q.requester_id),
            cancel_reason = 'UNMET_TRIP_TYPE_CHANGED' where id = v_old.id;
        end if;
        delete from public.ride_requests where ride_id = v_old.id and request_id = q.id;
        v_old_cars := v_old_cars || v_old.car_id;
      end loop;
      update public.requests set status = 'submitted', status_reason = 'UNMET_TRIP_TYPE_CHANGED' where id = q.id;
      foreach v_old_car in array v_old_cars loop
        perform public.assert_car_chain(v_old_car, q.week_start);
      end loop;
    end if;
  end if;
  -- R8B12: a request that had no car (or whose old car cannot take the new shape) is placed on any free shared car,
  -- exactly like the board's drop would; unplaced only when no car can take it.
  if not v_placed then
    v_ride := public.place_request_on_any_free_car(q.id, v_actor, v_dep, v_ret, 'TRIP_TYPE_CHANGED');
    v_placed := v_ride is not null;
  end if;
  perform set_config('app.system_status_transition', v_prev_sys, true);

  if q.requester_id is distinct from v_actor then
    perform public.enqueue_notification(q.requester_id, 'outcome_changed', q.department_id, q.week_start,
      '{}'::jsonb, jsonb_build_object('variant', 'trip_type_changed', 'request_id', q.id),
      format('trip_type_changed:%s:%s', q.id, q.version));
  end if;

  select status into v_status from public.requests where id = q.id;
  -- REQ §13.97: tell the caller when a kept return time came back (the board's toast says so).
  return jsonb_strip_nulls(jsonb_build_object('status', v_status, 'ride_id', v_ride, 'changed', true,
    'restored_return_at', case when q.return_at is null and v_ret is not null and v_defaulted is null then v_ret end,
    'defaulted_return_at', v_defaulted));
end;
$function$;

