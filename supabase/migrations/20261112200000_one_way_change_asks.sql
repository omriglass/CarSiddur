-- OW1 (REQ §13.210, owner 2026-11-12): changing one's own placed ride to "one way" asks instead of refusing.
-- A one-way trip leaves the car at the destination. Automatic placement refuses that when the car's next ride
-- starts elsewhere, or when it has no later ride and the destination is not its base — so the member's edit was
-- refused ("no car") and the Sadran's trip-type change quietly moved the request to another car or unplaced it.
-- Now both are asked first and may go ahead for the booked car only (transaction setting `app.car_stays_away`
-- = that car's id); the board's chain-break and week-end warnings stay as the reminder. Automatic placement of
-- new requests and the solver keep the rule.
--   submit_request      -> {ok:false, needs_confirmation:'car_stays_away', car_name, next_ride}; resubmit with allow_car_away
--   set_request_trip_type(…, p_allow_car_away) -> raises car_next_ride_elsewhere (detail ask:'car_stays_away') unless allowed

CREATE OR REPLACE FUNCTION public._auto_approve_free_car(p_request_id uuid, p_end timestamp with time zone, p_after interval, p_turnaround interval, p_pref uuid, p_is_one_way boolean)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select c.id
  from public.requests q
  join public.cars c on c.department_id = q.department_id
  join public.car_seat_configs csc on csc.car_id = c.id
  where q.id = p_request_id and c.status = 'active' and c.type = 'shared'
    and csc.adults >= q.adults and csc.child_seats >= q.child_seats and csc.boosters >= q.boosters
    and (not (q.has_luggage and q.luggage_waived_at is null) or 'large_trunk' = any(c.features))
    and (not (q.needs_tow_hitch and q.luggage_waived_at is null) or 'tow_hitch' = any(c.features))   -- REQ §13.200
    and public.car_location_at(c.id, q.depart_at) = q.origin_id
    and not exists (
      select 1 from public.rides r
      where r.car_id = c.id and r.status <> 'cancelled' and not r.draft_hold
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(q.depart_at, p_end + p_after, '[)')
    )
    and not public._draft_hold_conflict(c.id, q.depart_at, p_end + p_turnaround, array[q.id])
    -- REQ §13.114: never inside a scheduled maintenance period (incl. the turnaround buffer before it).
    and not exists (
      select 1 from public.car_maintenance_blocks b
      where b.car_id = c.id
        and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(q.depart_at, p_end + p_turnaround, '[)')
    )
    and (not p_is_one_way or public.car_week_end_ok(c.id, p_end, q.destination_id)
         -- OW1 (REQ §13.210): the person changing their own ride to one way said yes to leaving this car there.
         or c.id::text = nullif(current_setting('app.car_stays_away', true), ''))   -- REQ §13.136 c: no next ride -> the base
    -- R15B10: a car an open contested group's member could take stays theirs; the newcomer joins the group instead.
    and not public.car_held_by_waitlist_group(c.id, q.depart_at, p_end + p_turnaround, p_request_id)
  order by (c.id = p_pref) desc nulls last, c.id
  limit 1;
$function$;

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
  -- REQ §13.127 (c): so is a request the owner filed for someone else.
  perform public.assert_private_car_request(v_car, p_actor, p_request_id);
  v_manual := coalesce(p_manual, false);
  v_dep := case when q.trip_shape = 'one_way_from' then null else coalesce(p_dep, q.depart_at) end;
  v_ret := case when q.trip_type = 'one_way' or q.trip_shape = 'one_way_to' then null
                else coalesce(p_ret, q.return_at) end;
  if v_dep is null and v_ret is null then raise exception 'shift_car_invalid' using errcode = 'P0001'; end if;
  -- R13B14: confirmed only on a published day; the rest of the week's rides are drafts.
  v_public := public.is_day_public(q.department_id, q.week_start, (coalesce(v_dep, v_ret) at time zone 'Asia/Jerusalem')::date);
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
    -- REQ §13.206: nothing tracks where a private car is (its owner takes care of it) - the location rules below
    -- are for shared cars only.
    if exists(select 1 from public.cars where id = v_car and type = 'shared')
       and public.car_location_at(v_car, v_dep) is distinct from q.origin_id then
      raise exception 'car_not_at_leg_origin' using errcode = 'P0001';
    end if;
    -- REQ §13.93 (CH1, owner 2026-11-07): a Sadran who saw "לשבץ בכל זאת?" (payload `allow_chain_break`) may leave the
    -- car where its next ride does not start; the board's chain-break warning stays as the reminder.
    if exists(select 1 from public.cars where id = v_car and type = 'shared')
       and coalesce(public.car_next_ride_origin(v_car, v_end), q.destination_id) <> q.destination_id
       -- OW1 (REQ §13.210): the Sadran changing the trip type said yes ("לשנות בכל זאת?") for this car.
       and v_car::text is distinct from nullif(current_setting('app.car_stays_away', true), '')
       and not (v_manual and exists(select 1 from public.proposals pp
         where pp.id::text = nullif(current_setting('app.applying_proposal', true), '')
           and pp.created_via = 'sadran' and coalesce((pp.payload ->> 'allow_chain_break')::boolean, false))) then
      raise exception 'car_next_ride_elsewhere' using errcode = 'P0001';
    end if;
    -- REQ §13.136 c: an automatic placement never leaves a shared car away from its base with nothing bringing it
    -- back. A Sadran's manual placement and an accepted proposal (a human decision) stay allowed.
    if not v_manual and p_reason <> 'PROPOSAL_APPLIED'
       and exists(select 1 from public.cars where id = v_car and type = 'shared')
       and not public.car_week_end_ok(v_car, v_end, q.destination_id) then
      raise exception 'car_week_end_away' using errcode = 'P0001';
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
          or exists(select 1 from public.rides r where r.car_id = v_car and r.status <> 'cancelled' and not r.draft_hold
            and tstzrange(r.starts_at, case when v_manual then r.ends_at else r.blocked_until end, '[)')
              && tstzrange(v_s, case when v_manual then v_e else v_e + make_interval(mins => v_buffer) end, '[)'))
          or exists(select 1 from public.car_maintenance_blocks b where b.car_id = v_car
            and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_s, v_e, '[)'))
          or (c = 0 and (not public.car_fits(v_car, q.adults, q.child_seats, q.boosters)
            or coalesce(public.car_next_ride_origin(v_car, v_e), q.origin_id) <> q.origin_id
            -- REQ §13.136 c: the pickup relay ends the car at the origin; automatic, so never away from base
            or (not v_manual and p_reason <> 'PROPOSAL_APPLIED'
                and not public.car_week_end_ok(v_car, v_e, q.origin_id))));
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

-- A new parameter is a new signature: the old one is dropped (old clients' 4-argument calls resolve to the new one).
drop function if exists public.set_request_trip_type(uuid, public.trip_type, integer, boolean);

CREATE OR REPLACE FUNCTION public.set_request_trip_type(p_request_id uuid, p_trip_type trip_type, p_expected_version integer, p_keep_car boolean DEFAULT false, p_allow_car_away boolean DEFAULT false)
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
  -- REQ §13.126 g: the Sadran may also choose "round trip, the car stays at the destination" (a two-way הקפצה + the flag).
  v_keep boolean := coalesce(p_keep_car, false); v_keep_car_id uuid;
  v_place_error text;
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
  if q.trip_type = p_trip_type and q.keep_car_at_destination = v_keep then
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
    if v_keep then v_ret := coalesce(v_ret, q.kept_return_at); end if;
    if v_ret is not null then v_kept := null; end if;
    if v_ret is not null and v_dep is not null then v_shape := 'round_trip'; v_mode := null;
    elsif v_ret is not null then v_shape := 'one_way_from'; v_mode := coalesce(q.one_way_car_mode, v_driver_mode);
    else v_shape := 'one_way_to'; v_mode := coalesce(q.one_way_car_mode, v_driver_mode);
    end if;
  end if;
  if v_keep and (p_trip_type <> 'drop_off' or v_shape <> 'round_trip'
     or exists (select 1 from public.profiles p where p.id = q.requester_id and p.does_not_drive)) then
    raise exception 'invalid_keep_car_at_destination' using errcode = 'P0001';
  end if;
  if p_trip_type <> 'drop_off' and public.eligible_leg_driver(q.id) is null then
    raise exception 'non_driver_needs_drop_off' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'set_request_trip_type', true);
  v_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
  perform set_config('app.system_status_transition', 'on', true);

  update public.requests set trip_type = p_trip_type, trip_shape = v_shape, needs_car_at_destination = v_needs,
    -- REQ §13.126 g: "the car stays at the destination" only survives as a two-way הקפצה.
    keep_car_at_destination = v_keep,
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
      -- OW1 (REQ §13.210): a one-way trip leaves the car at the destination. When the car's next ride does not start
      -- there the Sadran is asked first (`car_next_ride_elsewhere`, nothing changed) and says yes with p_allow_car_away.
      perform set_config('app.car_stays_away', case when coalesce(p_allow_car_away, false) then v_car::text else '' end, true);
      v_ride := public.place_request_on_car(q.id, v_car, true, v_actor, null, v_dep, v_ret, 'TRIP_TYPE_CHANGED');
      v_placed := true;
    exception when sqlstate 'P0001' or sqlstate '23P01' or sqlstate '23514' then
      v_placed := false; v_ride := null; v_place_error := sqlerrm;
    end;
    perform set_config('app.car_stays_away', '', true);
    if v_place_error = 'car_next_ride_elsewhere' and p_trip_type = 'one_way' and not coalesce(p_allow_car_away, false) then
      raise exception 'car_next_ride_elsewhere' using errcode = 'P0001',
        detail = jsonb_build_object('ask', 'car_stays_away', 'car_name', (select c.name from public.cars c where c.id = v_car))::text;
    end if;
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
  if not v_placed and v_keep then
    -- REQ §13.126 g: both legs on ONE car (connected by assert_car_chain), else unplaced.
    for v_keep_car_id in
      select c.id from public.cars c where c.department_id = q.department_id and c.status = 'active' and c.type = 'shared'
      order by (c.id = q.preferred_car_id) desc nulls last, c.id
    loop
      begin
        v_ride := public.place_request_on_car(q.id, v_keep_car_id, true, v_actor, null, v_dep, v_ret, 'TRIP_TYPE_CHANGED');
        if coalesce(array_length(public.request_covered_legs(q.id), 1), 0) < 2
           or exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                      where rr.request_id = q.id and r.status <> 'cancelled' and r.car_id <> v_keep_car_id) then
          raise exception 'keep_car_both_legs' using errcode = 'PXKC1';
        end if;
        v_placed := true;
        exit;
      exception when others then
        v_ride := null;
      end;
    end loop;
  elsif not v_placed then
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

CREATE OR REPLACE FUNCTION public.submit_request(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_request_id uuid := nullif(payload ->> 'request_id', '')::uuid;
  v_requester_id uuid := coalesce(nullif(payload ->> 'requester_id', '')::uuid, v_actor);
  v_department_id uuid := (payload ->> 'department_id')::uuid;
  v_week_start date := (payload ->> 'week_start')::date;
  v_trip_shape public.trip_shape := coalesce((payload ->> 'trip_shape')::public.trip_shape, 'round_trip');
  v_depart_at timestamptz := nullif(payload ->> 'depart_at', '')::timestamptz;
  v_return_at timestamptz := nullif(payload ->> 'return_at', '')::timestamptz;
  v_one_way_mode public.leg_car_mode := nullif(payload ->> 'one_way_car_mode', '')::public.leg_car_mode;
  v_needs_car boolean := coalesce((payload ->> 'needs_car_at_destination')::boolean, true);
  v_preferred_car_id uuid := nullif(payload ->> 'preferred_car_id', '')::uuid;
  v_origin_id uuid := nullif(payload ->> 'origin_id', '')::uuid;
  v_origin_text text := nullif(payload ->> 'origin_text', '');
  v_trip_type_in text := nullif(payload ->> 'trip_type', '');
  v_trip_type public.trip_type;
  v_week record;
  v_existing record;
  v_can_manage boolean;
  v_is_late boolean;
  v_status public.request_status;
  v_warnings jsonb := '[]'::jsonb;
  v_join_ride_id uuid := nullif(payload ->> 'join_ride_id', '')::uuid;
  v_join_car_type public.car_type;
  v_ask_small boolean; v_allow_small boolean; v_small_car uuid; v_waived_here boolean := false; v_join_car uuid;
  v_join_owner uuid;
  v_auto_result jsonb;
  v_companion_ids uuid[];
  v_series_id uuid := nullif(payload ->> 'series_id', '')::uuid;
  v_series_index smallint := nullif(payload ->> 'series_index', '')::smallint;
  v_series_count smallint := nullif(payload ->> 'series_count', '')::smallint;
  v_eligible_driver uuid;
  v_kept timestamptz; v_prev_return timestamptz; v_prev_kept timestamptz;
  v_own_overlap boolean := false;
  -- Owner 2026-10-11: the requester answered "keep both" to the form's overlap warning (`overlap_confirmed`).
  v_overlap_confirmed boolean := coalesce((payload ->> 'overlap_confirmed')::boolean, false);
  v_overlap_unasked boolean := false;
  -- REQ §13.126 g: "הרכב זמין לשימוש ביעד" — a member-driven round trip whose car waits at the destination.
  v_keep_car boolean := coalesce((payload ->> 'keep_car_at_destination')::boolean, false);
  v_keep_car_id uuid;
  v_published_edit boolean := false; v_old_edit_car uuid; v_edit_ride uuid; v_edit_prev_sys text;
  v_needs_driver boolean;
  v_confirm boolean := coalesce((payload ->> 'confirm_release')::boolean, false);
  v_booking jsonb;
  v_probe jsonb;
  v_carry_from uuid;   -- REQ §13.205: the driver's ride whose added passengers go along to the new one
  v_carry_to uuid;
  v_carry_failed boolean := false;
  v_probe_away jsonb; v_away_car uuid;
  v_overlaps jsonb := '[]'::jsonb;
  v_probe_only boolean := coalesce((payload ->> 'probe_only')::boolean, false);
  v_late_variant text;
  v_depart_anchor public.time_anchor := 'leave'; v_arrive_by timestamptz;
  v_return_anchor public.time_anchor := 'arrive'; v_leave_dest_at timestamptz;
  v_anchors_explicit boolean := false;
  v_locked boolean := false;
  v_fallback public.request_fallback := 'none';
  v_is_edit boolean := nullif(payload ->> 'request_id', '') is not null;
  v_prev_fallback public.request_fallback := 'none'; v_prev_depart timestamptz; v_companion uuid;
  v_unchanged boolean := false; v_neutral boolean := false;
  -- REQ §13.127: filed for someone else; a member doing so follows the member's own flow (the requester's).
  v_on_behalf boolean;
  v_member_flow boolean;
  -- REQ §13.135 (c): a private car chosen in the form (the car's owner is the filer, the requester or who filed it).
  v_own_car uuid; v_own_turnaround int; v_own_by text; v_own_end timestamptz;
  v_hold_group uuid;
  -- REQ §13.169 (b): an edit may move the request to another rider (who drives); (c) a save from the request form.
  v_requester_changed boolean := false;
  v_form_notice boolean := public._ride_edit_notice_applies();
begin
  -- REQ §13.190: the browser asks before a short turnaround (`short_turnaround_ask`: try_auto_approve names the car's
  -- next ride instead of waitlisting) and retries with `allow_short_turnaround` once the member said yes.
  if coalesce((payload ->> 'allow_short_turnaround')::boolean, false) then
    perform set_config('app.short_turnaround', 'allow', true);
  elsif coalesce((payload ->> 'short_turnaround_ask')::boolean, false) then
    perform set_config('app.short_turnaround', 'offer', true);
  end if;
  -- REQ §13.127: an edit without `requester_id` keeps the stored requester (the editor may be anyone related).
  if v_request_id is not null and nullif(payload ->> 'requester_id', '') is null then
    select requester_id into v_requester_id from public.requests where id = v_request_id;
    v_requester_id := coalesce(v_requester_id, v_actor);
  end if;
  -- REQ §13.127: any approved member of the department may file for another member of it (checked below);
  -- before, only a Sadran could.
  v_can_manage := public.can_manage_week(v_department_id, v_week_start);
  v_on_behalf := v_actor is not null and v_requester_id <> v_actor;
  -- null (not false) for a session without a user, exactly like the `v_requester_id = v_actor` it replaces.
  v_member_flow := v_requester_id = v_actor or (v_on_behalf and not v_can_manage);
  -- REQ §13.135 (c): a private car is a preference only for its owner's requests (the owner files it, is the requester,
  -- or filed the request being edited); anyone else's private car (e.g. a grid tap on its column) is dropped, not refused.
  if v_preferred_car_id is not null and exists (
       select 1 from public.cars c where c.id = v_preferred_car_id and c.type = 'temporary'
         and c.owner_id is distinct from v_actor and c.owner_id is distinct from v_requester_id
         and (v_request_id is null or c.owner_id is distinct from (select q.filed_by from public.requests q where q.id = v_request_id))) then
    v_preferred_car_id := null;
  end if;

  select * into v_week from public.weeks where department_id = v_department_id and week_start = v_week_start;
  if v_week is null then
    raise exception 'week_not_open' using errcode = 'P0001';
  end if;
  -- REQ §13.77: a week that only exists as `upcoming` (materialized early for a series leg)
  -- is not open for an ordinary new request; series legs (series_id set) are exactly what
  -- put it there and are accepted.
  if v_week.phase = 'upcoming' and v_series_id is null then
    raise exception 'week_not_open' using errcode = 'P0001';
  end if;

  if not public.is_approved() or not public.member_of(v_department_id) and not v_can_manage then raise exception 'not_authorized'; end if;
  if v_week.phase = 'archived' then raise exception 'week_archived'; end if;
  -- REQ §13.100 (QB16): an immediate ("car now") request needs a live week. Refuse clearly instead of
  -- leaving it `submitted` in a week nobody is placing right now.
  if v_series_id is null and v_week.phase not in ('published', 'live') and not v_can_manage
     and v_depart_at is not null and v_depart_at <= now() + interval '1 hour'
     and v_depart_at >= now() - interval '1 hour' then
    raise exception 'car_now_week_not_live' using errcode = 'P0001';
  end if;
  -- REQ §13.155 (owner 2026-10-26): in a partly published week a day the Sadran has not published yet takes no
  -- member requests or edits (it was auto-approved onto a draft ride before); the week's Sadran still may.
  if v_week.phase in ('published', 'live') and not v_can_manage and cardinality(v_week.published_days) > 0
     and coalesce(v_depart_at, v_return_at) is not null
     and not ((coalesce(v_depart_at, v_return_at) at time zone 'Asia/Jerusalem')::date = any(v_week.published_days)) then
    raise exception 'day_not_published' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.department_members where department_id=v_department_id and profile_id=v_requester_id and removed_at is null) then raise exception 'not_authorized'; end if;

  if v_trip_shape <> 'round_trip' then
    v_needs_car := true;
    -- REQ §13.88: the member no longer chooses a car mode; when omitted, default to
    -- the requester's driving ability — a non-driver's leg is `passenger`, everyone
    -- else's is `relay`. An explicit value (Sadran/board, older clients) is kept as-is.
    if v_one_way_mode is null then
      select case when p.does_not_drive then 'passenger'::public.leg_car_mode else 'relay'::public.leg_car_mode end
        into v_one_way_mode
      from public.profiles p where p.id = v_requester_id;
    end if;
  end if;

  -- R6B7 (REQ §13.109): asking to join a ride the requester is already on is refused.
  if v_join_ride_id is not null and exists (
    select 1 from public.rides r where r.id = v_join_ride_id
      and (r.driver_id = v_requester_id
           or exists (select 1 from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id = v_requester_id)
           or exists (select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
                      where rr.ride_id = r.id and q.requester_id = v_requester_id and q.id is distinct from v_request_id)
           or exists (select 1 from public.ride_requests rr join public.request_companions rc on rc.request_id = rr.request_id
                      where rr.ride_id = r.id and rc.profile_id = v_requester_id))
  ) then
    raise exception 'join_own_ride' using errcode = 'P0001';
  end if;

  -- REQ §13.93: origin defaults to the requester's default_origin_id for this department,
  -- else the department home; an explicit origin_id/origin_text always wins.
  if v_origin_id is null and v_origin_text is null and v_join_ride_id is not null then
    select r.origin_id into v_origin_id from public.rides r where r.id = v_join_ride_id and r.department_id = v_department_id;
  end if;
  if v_origin_id is null and v_origin_text is null then
    select dm.default_origin_id into v_origin_id from public.department_members dm
      where dm.department_id = v_department_id and dm.profile_id = v_requester_id and dm.removed_at is null;
    if v_origin_id is null then
      select home_destination_id into v_origin_id from public.departments where id = v_department_id;
    end if;
  end if;

  -- R7B12 (REQ §13.109 e): the same place as origin and destination is refused.
  if (v_origin_id is not null and v_origin_id = nullif(payload ->> 'destination_id', '')::uuid)
     or (v_origin_text is not null and lower(btrim(v_origin_text)) = lower(btrim(coalesce(nullif(payload ->> 'destination_text', ''), '')))) then
    raise exception 'origin_equals_destination' using errcode = 'P0001';
  end if;

  -- REQ §13.93: trip_type is the source of truth when sent; otherwise derive it from the
  -- legacy fields above (same mapping as the 20261004100200 backfill).
  if v_trip_type_in is not null then
    v_trip_type := v_trip_type_in::public.trip_type;
    case v_trip_type
      when 'round_trip' then
        v_trip_shape := 'round_trip'; v_needs_car := true; v_one_way_mode := null;
      when 'one_way' then
        v_trip_shape := 'one_way_to'; v_needs_car := true; v_one_way_mode := 'relay';
      when 'drop_off' then
        if v_return_at is not null then
          v_trip_shape := 'round_trip'; v_needs_car := false; v_one_way_mode := null;
        else
          v_trip_shape := 'one_way_to'; v_needs_car := false;
          if v_one_way_mode is null then
            select case when p.does_not_drive then 'passenger'::public.leg_car_mode else 'relay'::public.leg_car_mode end
              into v_one_way_mode
            from public.profiles p where p.id = v_requester_id;
          end if;
        end if;
    end case;
  else
    v_trip_type := case when v_trip_shape = 'round_trip' and v_needs_car then 'round_trip'::public.trip_type else 'drop_off'::public.trip_type end;
  end if;
  -- REQ §13.126 g: only a two-way trip the requester drives (stored as a הקפצה with a pickup) keeps the car at the destination.
  if v_keep_car and (v_trip_type <> 'drop_off' or v_trip_shape <> 'round_trip'
     or exists (select 1 from public.profiles p where p.id = v_requester_id and p.does_not_drive)) then
    raise exception 'invalid_keep_car_at_destination' using errcode = 'P0001';
  end if;

  if v_request_id is not null then
    select * into v_existing from public.requests where id = v_request_id for update;
    if v_existing is null then
      raise exception 'request_not_found' using errcode = 'P0001';
    end if;
    -- REQ §13.127: everyone related to the request may edit it, not only the requester.
    if v_existing.requester_id <> v_actor and not public.request_related(v_request_id, v_actor)
       and not public.can_manage_week(v_existing.department_id, v_existing.week_start) then
      raise exception 'not_authorized' using errcode = 'P0001';
    end if;
    if v_existing.department_id is distinct from v_department_id or v_existing.week_start is distinct from v_week_start then raise exception 'not_authorized'; end if;
    -- REQ §13.169 (b): the who chip moves the request to the rider who drives (a member of the department, checked above).
    v_requester_changed := v_existing.requester_id is distinct from v_requester_id;
    -- REQ §13.169 (c): what the riders saw before this save.
    perform public._ride_edit_capture(v_request_id);
    -- REQ §13.77 v1: a multi-day series is cancelled and resubmitted, never edited leg by leg.
    if v_existing.series_id is not null or v_series_id is not null then
      raise exception 'series_edit_not_supported' using errcode = 'MDR02';
    end if;
    -- REQ §13.101 (f): on a published/live day the requester may edit their own request; the new
    -- version is placed (or released to the waiting list after a confirmation). A closed, unpublished
    -- day keeps request_window_closed (the member contacts the Sadran).
    -- REQ §13.127: so may anyone related to it (who filed it, a companion, someone on its ride, the private car's owner).
    v_published_edit := v_week.phase in ('published', 'live')
      and (v_requester_id = v_actor or (v_actor is not null and public.request_related(v_request_id, v_actor)));
    if v_published_edit then
      if coalesce(v_existing.return_at, v_existing.depart_at) < now() then raise exception 'request_not_editable'; end if;
    elsif not v_can_manage and (v_week.phase not in ('open','solving') or now() > v_week.close_at or now() < v_week.open_at) then raise exception 'request_window_closed'; end if;
    if v_existing.served_by_alternative then raise exception 'request_served_by_alternative' using errcode = 'P0001'; end if;
    if v_existing.status in ('cancelled','withdrawn') or (not v_published_edit and exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=v_request_id and r.status not in ('draft','cancelled'))) then raise exception 'request_not_editable'; end if;
    -- REQ §13.101 (h), R11B1: a save whose effective content equals the stored request changes nothing.
    v_unchanged := public._request_save_unchanged(v_request_id, payload, v_trip_type, v_trip_shape, v_needs_car, v_one_way_mode,
      v_origin_id, v_origin_text, v_depart_at, v_return_at);
    -- placement-neutral edit on a published/live day: only notes / description / ride type / preferred car / plan B changed
    v_neutral := v_published_edit and not v_unchanged and public._request_save_unchanged(v_request_id, payload, v_trip_type, v_trip_shape, v_needs_car,
      v_one_way_mode, v_origin_id, v_origin_text, v_depart_at, v_return_at, true);
    -- REQ §13.126 g: turning "the car is available at the destination" on or off changes how the trip is placed.
    if v_existing.keep_car_at_destination is distinct from v_keep_car or v_requester_changed then
      v_unchanged := false;
      v_neutral := false;
    end if;
    -- REQ §13.102 (f), R2B20: the form asks before saving whether an edit would lose the current booking.
    if v_probe_only then
      return jsonb_build_object('probe_only', true, 'request_id', v_request_id, 'unchanged', v_unchanged, 'placement_neutral', v_neutral,
        -- REQ §13.158: a published/live-day edit never loses its booking (it is placed or refused).
        'would_lose_booking', not v_published_edit and not v_unchanged and not v_neutral and (v_existing.status in ('assigned', 'merged', 'proposed') or exists (
          select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
          where rr.request_id = v_request_id and r.status <> 'cancelled')),
        'drives_others', coalesce((public.request_booking_info(v_request_id) ->> 'drives_others')::boolean, false),
        'affected_names', coalesce(public.request_booking_info(v_request_id) -> 'affected_names', '[]'::jsonb));
    end if;
    if not (payload ? 'expected_version') then perform public.raise_stale_version(); end if;
    if v_existing.version is distinct from (payload ->> 'expected_version')::int then
      perform public.raise_stale_version();
    end if;
    if v_unchanged then
      return jsonb_build_object('ok', true, 'unchanged', true, 'request_id', v_request_id, 'status', v_existing.status,
        'is_late', v_existing.is_late, 'warnings', '[]'::jsonb, 'overlaps', '[]'::jsonb);
    end if;
    if v_neutral then
      -- stored in place (the plan B is validated and saved by the same helper a normal edit uses)
      perform set_config('app.audit_reason', 'submit_request', true);
      update public.requests set
        notes = case when payload ? 'notes' then nullif(payload ->> 'notes', '') else notes end,
        ride_type_id = coalesce((payload ->> 'ride_type_id')::uuid, ride_type_id),
        ride_description = case when payload ? 'ride_description' then payload ->> 'ride_description' else ride_description end,
        preferred_car_id = case when payload ? 'preferred_car_id' then v_preferred_car_id else preferred_car_id end,
        fallback = public._request_fallback_from_payload(payload, fallback)
      where id = v_request_id;
      if payload ? 'fallback' or payload ? 'alternative' or v_existing.fallback <> 'none' then
        perform public._save_request_alternative(v_request_id, payload, v_existing.depart_at);
      end if;
      perform public.enqueue_notification(s.profile_id, 'request_changed', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
        format('request_changed:%s:%s', v_request_id, now()))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id);
      if not v_form_notice then perform public._notify_request_edited_by_manager(v_request_id, v_actor); end if;
      return jsonb_build_object('ok', true, 'placement_neutral', true, 'unchanged', false, 'request_id', v_request_id,
        'status', v_existing.status, 'is_late', v_existing.is_late, 'warnings', '[]'::jsonb, 'overlaps', '[]'::jsonb);
    end if;
    if v_published_edit then
      v_booking := public.request_booking_info(v_request_id);
      if (v_booking ->> 'has_booking')::boolean and coalesce(current_setting('app.edit_probe_inner', true), 'off') <> 'on' then
        -- Probe: run the whole edit (release + new placement) in a subtransaction. A clean move onto a
        -- free car is kept (with others on the ride only once the member confirmed); anything else is rolled back.
        -- REQ §13.205 (owner 2026-11-09, production: a driver shortened his ride and the member who had joined it with
        -- "add passengers" was dropped): when the member drives their own ride and nobody else's request is on it — only people
        -- added to it — those people go along to wherever the new hours are placed; no question asked.
        select r.id into v_carry_from
        from public.ride_requests rr join public.rides r on r.id = rr.ride_id
        where rr.request_id = v_request_id and r.status not in ('cancelled', 'draft') and r.driver_id = v_existing.requester_id
          and exists (select 1 from public.ride_passengers rp where rp.ride_id = r.id)
          and not exists (select 1 from public.ride_requests x where x.ride_id = r.id and x.request_id <> v_request_id)
          and (select count(*) from public.ride_requests y join public.rides ry on ry.id = y.ride_id
               where y.request_id = v_request_id and ry.status not in ('cancelled', 'draft')) = 1;
        begin
          perform set_config('app.edit_probe_inner', 'on', true);
          v_probe := public.submit_request(payload || jsonb_build_object('confirm_release', true));
          perform set_config('app.edit_probe_inner', 'off', true);
          -- REQ §13.176: the new hours would be placed but overlap the member's own ride or request: ask first
          if coalesce(v_probe ->> 'status', '') = 'assigned' and coalesce((v_probe ->> 'overlap_unasked')::boolean, false) then
            perform public._ask_request_overlap(v_requester_id, v_depart_at, v_return_at, v_request_id);
          end if;
          if v_carry_from is not null and coalesce(v_probe ->> 'status', '') = 'assigned' then
            select r.id into v_carry_to
            from public.ride_requests rr join public.rides r on r.id = rr.ride_id
            where rr.request_id = v_request_id and r.status not in ('cancelled', 'draft') and r.id <> v_carry_from
            order by r.starts_at limit 1;
            -- the new ride must seat the request and everyone added (the request's own seats are on its row)
            if v_carry_to is null or not public.car_fits((select car_id from public.rides where id = v_carry_to),
                 (select coalesce(q.adults, 1) from public.requests q where q.id = v_request_id)::int
                   + (select count(*) from public.ride_passengers rp where rp.ride_id = v_carry_from and rp.seat_kind = 'adult')::int,
                 (select coalesce(q.child_seats, 0) from public.requests q where q.id = v_request_id)::int
                   + (select count(*) from public.ride_passengers rp where rp.ride_id = v_carry_from and rp.seat_kind = 'child_seat')::int,
                 (select coalesce(q.boosters, 0) from public.requests q where q.id = v_request_id)::int
                   + (select count(*) from public.ride_passengers rp where rp.ride_id = v_carry_from and rp.seat_kind = 'booster')::int) then
              v_carry_failed := true;
              raise exception 'release_probe_rollback' using errcode = 'PXRP1';
            end if;
            update public.ride_passengers set ride_id = v_carry_to where ride_id = v_carry_from;
            -- they were told the old ride was cancelled a moment ago; they are not losing it (the edit notice tells them
            -- the new hours), so that notice is taken back before it is delivered (its outbox rows go with it)
            delete from public.notifications n
            where n.event = 'outcome_changed' and n.data ->> 'variant' = 'ride_cancelled' and n.data ->> 'ride_id' = v_carry_from::text
              and n.recipient_id in (select rp.person_id from public.ride_passengers rp where rp.ride_id = v_carry_to);
            perform set_config('app.edit_probe_inner', 'off', true);
            return v_probe;
          end if;
          if coalesce(v_probe ->> 'status', '') = 'assigned' and (v_confirm or not (v_booking ->> 'drives_others')::boolean) then
            return v_probe;
          end if;
          raise exception 'release_probe_rollback' using errcode = 'PXRP1';
        exception when sqlstate 'PXRP1' then
          null;
        end;
        if coalesce(v_probe ->> 'status', '') = 'assigned' and not v_carry_failed then
          -- the new hours fit a car, but the member drives others who would be left without a driver: ask
          return jsonb_build_object('needs_confirmation', 'release_to_waitlist', 'unchanged', false,
            'drives_others', true, 'would_place', true,
            'affected_names', coalesce(v_booking -> 'affected_names', '[]'::jsonb));
        end if;
        -- OW1 (REQ §13.210): a change to one way that is refused only because the booked car would stay at the
        -- destination (its next ride starts elsewhere, or the week ends with it away from its base) asks instead:
        -- nothing changes now; the form resubmits with `allow_car_away`.
        if v_trip_type = 'one_way' and not coalesce((payload ->> 'allow_car_away')::boolean, false) then
          select r.car_id into v_away_car from public.ride_requests rr join public.rides r on r.id = rr.ride_id
          where rr.request_id = v_request_id and r.status <> 'cancelled' order by r.starts_at limit 1;
          begin
            perform set_config('app.edit_probe_inner', 'on', true);
            v_probe_away := public.submit_request(payload || jsonb_build_object('confirm_release', true, 'allow_car_away', true));
            raise exception 'release_probe_rollback' using errcode = 'PXRP1';
          exception when sqlstate 'PXRP1' then
            null;
          end;
          perform set_config('app.edit_probe_inner', 'off', true);
          perform set_config('app.car_stays_away', '', true);
          if coalesce(v_probe_away ->> 'status', '') = 'assigned'
             and (v_confirm or not coalesce((v_booking ->> 'drives_others')::boolean, false)) then
            return jsonb_build_object('ok', false, 'needs_confirmation', 'car_stays_away', 'unchanged', false,
              'request_id', v_request_id, 'status', v_existing.status,
              'car_name', (select c.name from public.cars c where c.id = v_away_car),
              -- which of the two reasons: a later ride of the car (true), or none and the car ends away from its base
              'next_ride', public.car_next_ride_origin(v_away_car, v_depart_at + interval '1 minute') is not null,
              'warnings', '[]'::jsonb, 'overlaps', '[]'::jsonb);
          end if;
        end if;
        -- REQ §13.158: an edit never costs the member the car. No car takes the new hours, so nothing changes;
        -- `discussion` when an open waiting-list discussion holds the car in those hours (try_auto_approve's offer).
        v_hold_group := coalesce(nullif(v_probe ->> 'group_offer', '')::uuid, (
          select public.waitlist_group_holding(c.id, v_depart_at,
            coalesce(v_return_at, v_depart_at) + make_interval(mins => coalesce(public.required_turnaround_minutes(v_department_id, v_week_start), 30)), v_request_id)
          from public.cars c
          where c.department_id = v_department_id and c.status = 'active' and c.type = 'shared'
            and public.waitlist_group_holding(c.id, v_depart_at,
              coalesce(v_return_at, v_depart_at) + make_interval(mins => coalesce(public.required_turnaround_minutes(v_department_id, v_week_start), 30)), v_request_id) is not null
          order by c.id limit 1));
        -- QA run 17 R17B13: `riders` when the member drives others on the ride — the car stays with them, so the new
        -- hours need the Sadran (or the riders' own edits), not "no car".
        return jsonb_build_object('ok', false, 'edit_refused', case when v_hold_group is not null then 'discussion'
            when coalesce((v_booking ->> 'drives_others')::boolean, false) then 'riders' else 'no_car' end,
          'group_offer', v_hold_group, 'short_turnaround', v_probe -> 'short_turnaround', 'request_id', v_request_id, 'unchanged', false, 'status', v_existing.status,
          'warnings', '[]'::jsonb, 'overlaps', '[]'::jsonb);
      end if;
    end if;
  end if;

  if v_probe_only then
    return jsonb_build_object('probe_only', true, 'would_lose_booking', false, 'unchanged', false);
  end if;

  -- A one-way shape stores no return_at: remember the last real one (payload, else the stored one) in
  -- kept_return_at; a shape that needs a return and got none gets the kept one back.
  if v_request_id is not null then
    v_prev_return := v_existing.return_at; v_prev_kept := v_existing.kept_return_at;
    v_prev_fallback := v_existing.fallback; v_prev_depart := v_existing.depart_at;
  end if;
  -- REQ §13.112 (a)/(b): the fallback this submit stores (validated token; the plan B row is written below).
  v_fallback := public._request_fallback_from_payload(payload, v_prev_fallback);
  if v_trip_shape = 'one_way_to' then
    v_kept := coalesce(v_return_at, v_prev_return, v_prev_kept);
    v_return_at := null;
  else
    v_return_at := coalesce(v_return_at, v_prev_kept);
  end if;

  -- REQ §13.110 (b): the way each end was entered. Stored values (update) or defaults (insert) unless the
  -- payload carries the keys; an explicit key set is validated as a whole.
  if v_request_id is not null then
    v_depart_anchor := v_existing.depart_anchor; v_arrive_by := v_existing.arrive_by;
    v_return_anchor := v_existing.return_anchor; v_leave_dest_at := v_existing.leave_dest_at;
  end if;
  if payload ? 'depart_anchor' or payload ? 'arrive_by' then
    if nullif(payload ->> 'depart_anchor', '') is not null and (payload ->> 'depart_anchor') not in ('leave', 'arrive') then
      raise exception 'invalid_anchor' using errcode = 'P0001';
    end if;
    v_depart_anchor := coalesce(nullif(payload ->> 'depart_anchor', '')::public.time_anchor, v_depart_anchor);
    v_arrive_by := nullif(payload ->> 'arrive_by', '')::timestamptz;
    v_anchors_explicit := true;
  end if;
  if payload ? 'return_anchor' or payload ? 'leave_dest_at' then
    if nullif(payload ->> 'return_anchor', '') is not null and (payload ->> 'return_anchor') not in ('leave', 'arrive') then
      raise exception 'invalid_anchor' using errcode = 'P0001';
    end if;
    v_return_anchor := coalesce(nullif(payload ->> 'return_anchor', '')::public.time_anchor, v_return_anchor);
    v_leave_dest_at := nullif(payload ->> 'leave_dest_at', '')::timestamptz;
    v_anchors_explicit := true;
  end if;
  if v_anchors_explicit then
    if (v_depart_anchor = 'arrive') <> (v_arrive_by is not null) then
      raise exception 'anchor_time_mismatch' using errcode = 'P0001';
    end if;
    -- A one-way request keeps its (inactive) leave-there time (REQ §13.97), so only a request with a
    -- return needs the return end to be consistent.
    if (v_return_at is not null and (v_return_anchor = 'leave') <> (v_leave_dest_at is not null))
       or (v_return_anchor <> 'leave' and v_leave_dest_at is not null) then
      raise exception 'anchor_time_mismatch' using errcode = 'P0001';
    end if;
    if v_arrive_by is not null and (
         not public.is_quarter_hour(v_arrive_by) or v_depart_at is null
         or (v_arrive_by at time zone 'Asia/Jerusalem')::date
              not between (v_depart_at at time zone 'Asia/Jerusalem')::date and (v_depart_at at time zone 'Asia/Jerusalem')::date + 1) then
      raise exception 'invalid_anchor_time' using errcode = 'P0001';
    end if;
    if v_leave_dest_at is not null and (
         not public.is_quarter_hour(v_leave_dest_at)
         or (coalesce(v_return_at, v_kept, v_depart_at) is not null and (v_leave_dest_at at time zone 'Asia/Jerusalem')::date
              not between (coalesce(v_return_at, v_kept, v_depart_at) at time zone 'Asia/Jerusalem')::date - 1
                      and (coalesce(v_return_at, v_kept, v_depart_at) at time zone 'Asia/Jerusalem')::date)) then
      raise exception 'invalid_anchor_time' using errcode = 'P0001';
    end if;
  end if;

  -- REQ §13.112 (c): "N hours somewhere in a window". An explicit `duration_locked` is validated as a whole; without the
  -- key the stored lock survives only an edit that keeps the block's length (a classic-form edit of the times drops it).
  if payload ? 'duration_locked' then
    v_locked := coalesce((payload ->> 'duration_locked')::boolean, false);
    if v_locked then
      perform public.assert_duration_lock(v_trip_type, v_series_id, v_depart_at, v_return_at,
        coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, '0'), coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, '0'),
        coalesce(nullif(payload ->> 'flex_return_early', '')::interval, '0'), coalesce(nullif(payload ->> 'flex_return_late', '')::interval, '0'),
        v_depart_anchor, v_return_anchor);
    end if;
  elsif v_request_id is not null then
    v_locked := v_existing.duration_locked and v_return_at - v_depart_at = v_existing.return_at - v_existing.depart_at;
  end if;

  if coalesce((payload->>'reserve_missing_driver')::boolean,false) and (
    v_request_id is not null or (v_requester_id is distinct from v_actor and not coalesce(v_member_flow, false)) or v_week.phase<>'live' or v_trip_shape='round_trip' or v_trip_type<>'drop_off' or v_join_ride_id is not null
  ) then raise exception 'invalid_quick_reservation';end if;
  if v_request_id is not null then perform public.release_request_draft_rides(v_request_id); end if;
  if v_request_id is not null and v_published_edit and coalesce((v_booking ->> 'has_booking')::boolean, false) then
    -- confirmed (or probed) release of the old booking; the request starts over as `submitted`.
    -- R3B14: remember the booked car so the re-placement keeps it when it still fits.
    select r.car_id into v_old_edit_car from public.ride_requests rr join public.rides r on r.id = rr.ride_id
    where rr.request_id = v_request_id and r.status <> 'cancelled' order by r.starts_at limit 1;
    perform set_config('app.edit_prefer_car', coalesce(v_old_edit_car::text, ''), true);
    -- OW1 (REQ §13.210): the member said yes to leaving the booked car at the destination.
    perform set_config('app.car_stays_away', case when v_trip_type = 'one_way' and coalesce((payload ->> 'allow_car_away')::boolean, false)
      then coalesce(v_old_edit_car::text, '') else '' end, true);
    -- REQ §13.158: the old booking keeps counting against waiting-list holds (car_held_by_waitlist_group).
    perform set_config('app.edit_kept_rides', coalesce((select jsonb_agg(jsonb_build_object('car', r.car_id, 'from', r.starts_at, 'until', r.blocked_until))
      from public.ride_requests rr join public.rides r on r.id = rr.ride_id
      where rr.request_id = v_request_id and r.status <> 'cancelled' and r.car_id is not null), '[]'::jsonb)::text, true);
    perform public.release_request_booking(v_request_id);
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'submitted', status_reason = null where id = v_request_id;
    perform set_config('app.system_status_transition', 'off', true);
  end if;

  v_is_late := now() > v_week.close_at;
  -- R13M3: the Sadran editing someone else's request after the closing time does not make it late — it keeps its
  -- own lateness (no "late request" notice either; R13B15 already keeps the acting Sadran out of the Sadran notices).
  if v_request_id is not null and v_can_manage then   -- an edit (v_existing is only loaded for one)
    if v_existing.requester_id is distinct from v_actor then
      v_is_late := coalesce(v_existing.is_late, false);
    end if;
  end if;
  -- R2U4: a late request tells the Sadranim once (below), with its outcome, instead of late + waitlisted + contested.
  perform set_config('app.late_request_notice', case when v_is_late and v_series_id is null and not coalesce((payload->>'reserve_missing_driver')::boolean,false) then 'on' else 'off' end, true);

  perform set_config('app.audit_reason', 'submit_request', true);

  perform set_config('app.reset_request_baseline',case when v_member_flow then 'on' else 'off' end,true);
  if v_request_id is null then
    v_status := 'submitted';
    insert into public.requests (
      department_id, week_start, requester_id, filed_by, destination_id, destination_text, ride_type_id,
      origin_id, origin_text, trip_type,
      trip_shape, depart_at, return_at, one_way_car_mode, needs_car_at_destination,
      adults, child_seats, boosters, has_luggage, needs_tow_hitch,
      flex_depart_early, flex_depart_late, flex_return_early, flex_return_late,
      notes, is_late, submitted_at, status, freed_slot_opt_out, join_ride_id, template_id, preferred_car_id,
      series_id, series_index, series_count, kept_return_at,
      depart_anchor, arrive_by, return_anchor, leave_dest_at, duration_locked, fallback, keep_car_at_destination
    ) values (
      v_department_id, v_week_start, v_requester_id, v_actor,
      nullif(payload ->> 'destination_id', '')::uuid, nullif(payload ->> 'destination_text', ''),
      (payload ->> 'ride_type_id')::uuid,
      v_origin_id, v_origin_text, v_trip_type,
      v_trip_shape, v_depart_at, v_return_at, v_one_way_mode, v_needs_car,
      coalesce((payload ->> 'adults')::smallint, 1), coalesce((payload ->> 'child_seats')::smallint, 0),
      coalesce((payload ->> 'boosters')::smallint, 0), coalesce((payload ->> 'has_luggage')::boolean, false),
      coalesce((payload ->> 'needs_tow_hitch')::boolean, false),
      coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_return_early', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_return_late', '')::interval, '0'),
      nullif(payload ->> 'notes', ''), v_is_late, now(), v_status,
      coalesce((payload ->> 'freed_slot_opt_out')::boolean, false),
      v_join_ride_id, nullif(payload ->> 'template_id', '')::uuid, v_preferred_car_id,
      v_series_id, v_series_index, v_series_count, v_kept,
      v_depart_anchor, v_arrive_by, v_return_anchor, v_leave_dest_at, v_locked, v_fallback, v_keep_car
    ) returning id into v_request_id;
  else
    -- The shift trigger moves a stored entered time with depart_at/return_at unless this statement sets it.
    perform set_config('app.request_anchors_explicit', case when v_anchors_explicit then 'on' else 'off' end, true);
    perform set_config('app.duration_lock_explicit', 'on', true);
    update public.requests set
      requester_id = v_requester_id,
      destination_id = nullif(payload ->> 'destination_id', '')::uuid,
      destination_text = nullif(payload ->> 'destination_text', ''),
      ride_type_id = (payload ->> 'ride_type_id')::uuid,
      origin_id = v_origin_id, origin_text = v_origin_text, trip_type = v_trip_type,
      trip_shape = v_trip_shape, depart_at = v_depart_at, return_at = v_return_at, kept_return_at = v_kept,
      one_way_car_mode = v_one_way_mode, needs_car_at_destination = v_needs_car,
      adults = coalesce((payload ->> 'adults')::smallint, adults),
      child_seats = coalesce((payload ->> 'child_seats')::smallint, child_seats),
      boosters = coalesce((payload ->> 'boosters')::smallint, boosters),
      has_luggage = coalesce((payload ->> 'has_luggage')::boolean, has_luggage),
      needs_tow_hitch = coalesce((payload ->> 'needs_tow_hitch')::boolean, needs_tow_hitch),
      flex_depart_early = coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, flex_depart_early),
      flex_depart_late = coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, flex_depart_late),
      flex_return_early = coalesce(nullif(payload ->> 'flex_return_early', '')::interval, flex_return_early),
      flex_return_late = coalesce(nullif(payload ->> 'flex_return_late', '')::interval, flex_return_late),
      notes = case when payload ? 'notes' then nullif(payload ->> 'notes','') else notes end,
      is_late = v_is_late,
      freed_slot_opt_out = coalesce((payload ->> 'freed_slot_opt_out')::boolean, freed_slot_opt_out),
      join_ride_id = coalesce(v_join_ride_id, join_ride_id),
      preferred_car_id = case when payload ? 'preferred_car_id' then v_preferred_car_id else preferred_car_id end,
      depart_anchor = v_depart_anchor, arrive_by = v_arrive_by,
      return_anchor = v_return_anchor, leave_dest_at = v_leave_dest_at, duration_locked = v_locked,
      fallback = v_fallback,
      keep_car_at_destination = v_keep_car,
      changed_since_solve = (v_week.phase not in ('open','solving'))
    where id = v_request_id
    returning status into v_status;
    perform set_config('app.request_anchors_explicit', 'off', true);
    perform set_config('app.duration_lock_explicit', 'off', true);
    -- REQ §13.169 (b): the new requester is no longer a companion of their own request (the form sends the rest).
    if v_requester_changed then
      delete from public.request_companions where request_id = v_request_id and profile_id = v_requester_id;
    end if;

    if v_week.phase in ('solving','published','live') then
      perform public.enqueue_notification(s.profile_id, 'request_changed', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
        format('request_changed:%s:%s', v_request_id, now()))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id);
    end if;
    if not v_form_notice then perform public._notify_request_edited_by_manager(v_request_id, v_actor); end if;
  end if;

  perform set_config('app.reset_request_baseline','off',true);
  if payload ? 'ride_description' or payload ? 'guest_passenger_names' then
    if payload ? 'ride_description' and jsonb_typeof(payload->'ride_description') not in ('string','null') then raise exception 'invalid_ride_description';end if;
    if payload ? 'guest_passenger_names' and jsonb_typeof(payload->'guest_passenger_names') not in ('array','null') then raise exception 'invalid_passenger_names';end if;
    if payload ? 'guest_passenger_names' and jsonb_typeof(payload->'guest_passenger_names')='array' and exists(
      select 1 from jsonb_array_elements(payload->'guest_passenger_names') value where jsonb_typeof(value)<>'string') then raise exception 'invalid_passenger_names';end if;
    update public.requests set ride_description=case when payload ? 'ride_description' then payload->>'ride_description' else ride_description end,
      guest_passenger_names=case when payload ? 'guest_passenger_names' then array(select jsonb_array_elements_text(case when payload->'guest_passenger_names'='null'::jsonb then '[]'::jsonb else payload->'guest_passenger_names' end)) else guest_passenger_names end
      where id=v_request_id;
  end if;
  if payload ? 'companion_ids' then
    if jsonb_typeof(payload->'companion_ids') not in ('array','null') then raise exception 'invalid_companions';end if;
    select array_agg(value::uuid) into v_companion_ids from jsonb_array_elements_text(case when payload->'companion_ids'='null'::jsonb then '[]'::jsonb else payload->'companion_ids' end);
    if cardinality(v_companion_ids)>20 or cardinality(v_companion_ids)<>(select count(distinct id) from unnest(v_companion_ids) id)
      or exists(select 1 from unnest(v_companion_ids) candidate(profile_id) where candidate.profile_id=v_requester_id or not exists(
        select 1 from public.profiles p join public.department_members dm on dm.profile_id=p.id where p.id=candidate.profile_id
        and p.approval_status='approved' and dm.department_id=v_department_id and dm.removed_at is null)) then raise exception 'invalid_companions';end if;
    delete from public.request_companions where request_id=v_request_id;
    insert into public.request_companions(request_id,profile_id) select v_request_id,id from unnest(v_companion_ids) id;
  end if;
  if payload ? 'guest_passenger_names' or payload ? 'companion_ids' then perform public.assert_named_passenger_counts(v_request_id);end if;

  -- REQ §13.93 "Multi-stop rides": payload `stops` replaces the request's whole set, in route
  -- order per leg; absent key = leave existing stops untouched (same convention as `notes`).
  if payload ? 'stops' then
    perform public.replace_request_stops(v_request_id, v_department_id, v_return_at is not null, payload -> 'stops');
  end if;

  -- REQ §13.112 (a)/(b): plan B / "אסתדר" (validated against the row just written; keys absent = keep, moved with the day).
  if payload ? 'fallback' or payload ? 'alternative' or (v_is_edit and v_fallback <> 'none') then
    perform public._save_request_alternative(v_request_id, payload, v_prev_depart);
  end if;

  -- REQ §13.93: a requester who does not drive, and has no driving companion on board,
  -- may only file a הקפצה (drop_off) -- checked after companions are written above.
  if v_trip_type <> 'drop_off' then
    v_eligible_driver := public.eligible_leg_driver(v_request_id);
    if v_eligible_driver is null then
      raise exception 'non_driver_needs_drop_off' using errcode = 'P0001';
    end if;
  end if;

  -- Duplicate detection (warn, never block, REQ §5.3).
  if exists (
    select 1 from public.requests q
    where q.requester_id = v_requester_id and q.id <> v_request_id and q.status not in ('withdrawn','cancelled','denied','external')
      and q.department_id = v_department_id
      -- REQ §13.77: the legs of one multi-day series overlap each other by construction.
      and (v_series_id is null or q.series_id is distinct from v_series_id)
      and public.request_span(q.depart_at, q.return_at) && public.request_span(v_depart_at, v_return_at)
  ) then
    v_warnings := v_warnings || '"DUPLICATE_OVERLAP"'::jsonb;
    v_own_overlap := v_series_id is null;
  end if;
  -- REQ §13.100 (QB8): an overlapping ride the member already has (driver, or named on a reservation),
  -- not only an overlapping request.
  -- REQ §13.176: only the member's own part of that ride counts (a pickup on the way back leaves the morning free).
  if v_series_id is null and not v_own_overlap and (
    exists (select 1 from public._person_busy_rides(v_requester_id, public.request_span(v_depart_at, v_return_at), null, v_request_id, false) b
            join public.rides r on r.id = b.ride_id where r.department_id = v_department_id)
    or (v_join_ride_id is not null and exists (
      select 1 from public._person_busy_rides(v_requester_id, (select tstzrange(j.starts_at, j.ends_at, '[)') from public.rides j where j.id = v_join_ride_id),
                                              v_join_ride_id, v_request_id, false) b
      join public.rides r on r.id = b.ride_id where r.department_id = v_department_id))
  ) then
    v_warnings := v_warnings || '"DUPLICATE_OVERLAP"'::jsonb;
    v_own_overlap := true;
  end if;

  -- REQ §13.101 (g): name the member's own overlapping requests/rides so the form can offer to cancel one.
  if v_series_id is null then
    select coalesce(jsonb_agg(x.o), '[]'::jsonb) into v_overlaps from (
      select jsonb_build_object('request_id', y.request_id, 'ride_id', y.ride_id) as o from (
        select q.id as request_id,
               (select rr.ride_id from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                 where rr.request_id = q.id and r.status not in ('cancelled', 'draft') order by r.starts_at limit 1) as ride_id
        from public.requests q
        where q.requester_id = v_requester_id and q.id <> v_request_id and q.department_id = v_department_id
          and q.status not in ('withdrawn','cancelled','denied','external')
          and public.request_span(q.depart_at, q.return_at) && public.request_span(v_depart_at, v_return_at)
        union
        select (select rr.request_id from public.ride_requests rr join public.requests rq on rq.id = rr.request_id
                 where rr.ride_id = r.id and rq.requester_id = v_requester_id order by rr.request_id limit 1), r.id
        from public.rides r
        where r.department_id = v_department_id
          and (r.id in (select b.ride_id from public._person_busy_rides(v_requester_id, public.request_span(v_depart_at, v_return_at), null, v_request_id, false) b)
           or (v_join_ride_id is not null and r.id in (select b.ride_id from public._person_busy_rides(v_requester_id,
                 (select tstzrange(j.starts_at, j.ends_at, '[)') from public.rides j where j.id = v_join_ride_id), v_join_ride_id, v_request_id, false) b)))
      ) y
    ) x;
  end if;

  -- Seat-fit warning (warn, never block).
  if not exists (
    select 1 from public.cars c join public.car_seat_configs csc on csc.car_id = c.id
    where c.department_id = v_department_id and c.status = 'active'
      and csc.adults >= coalesce((payload ->> 'adults')::smallint, 1)
      and csc.child_seats >= coalesce((payload ->> 'child_seats')::smallint, 0)
      and csc.boosters >= coalesce((payload ->> 'boosters')::smallint, 0)
  ) then
    v_warnings := v_warnings || '"NO_CAR_FITS_SEATS"'::jsonb;
  end if;
  -- REQ §13.101 (a): large luggage needs a car with a large trunk.
  if coalesce((payload ->> 'has_luggage')::boolean, false) and not exists (
    select 1 from public.cars c where c.department_id = v_department_id and c.status = 'active' and 'large_trunk' = any(c.features)
  ) then
    v_warnings := v_warnings || '"NO_CAR_FITS_LUGGAGE"'::jsonb;
  end if;
  -- REQ §13.200: a towing request needs a car with the hitch.
  if coalesce((payload ->> 'needs_tow_hitch')::boolean, false) and not exists (
    select 1 from public.cars c where c.department_id = v_department_id and c.status = 'active' and 'tow_hitch' = any(c.features)
  ) then
    v_warnings := v_warnings || '"NO_CAR_FITS_TOW_HITCH"'::jsonb;
  end if;

  -- REQ §13.111 (a): a member's own placement choices may waive their large-trunk requirement: a quick / car-now
  -- request (payload `ask_small_trunk`) and ask-to-join (`join_ride_id`) refuse with needs_large_trunk when a car
  -- without a large trunk would be the only way to place them, unless the payload carries `allow_small_trunk`.
  -- Plain submits (no flag) and the automatic placement stay strict.
  v_allow_small := coalesce((payload ->> 'allow_small_trunk')::boolean, false);
  v_ask_small := v_allow_small or coalesce((payload ->> 'ask_small_trunk')::boolean, false) or v_join_ride_id is not null;
  if v_join_ride_id is not null and (public.request_needs_large_trunk(v_request_id) or public.request_needs_tow_hitch(v_request_id)) then
    select r.car_id into v_join_car from public.rides r where r.id = v_join_ride_id;
    if v_join_car is not null and not public.car_meets_needs(v_join_car,
         case when public.request_needs_large_trunk(v_request_id) then 1 else 0 end,
         case when public.request_needs_tow_hitch(v_request_id) then 1 else 0 end) then
      if not v_allow_small then
        raise exception 'needs_large_trunk' using errcode = 'P0001', detail = public._small_trunk_detail(array[v_request_id], v_join_car);
      end if;
      update public.requests set luggage_waived_at = now(), luggage_waived_by = v_actor where id = v_request_id;
    end if;
  end if;

  -- "Ask to join" a temporary car: create + send the merge proposal straight to the owner (REQ §13.43).
  if v_join_ride_id is not null then
    select c.type, c.owner_id into v_join_car_type, v_join_owner
    from public.rides r join public.cars c on c.id = r.car_id where r.id = v_join_ride_id;
    if v_join_car_type = 'temporary' then
      perform public.create_proposal(v_request_id, v_join_ride_id, 'merge',
        jsonb_build_object('ride_id', v_join_ride_id, 'legs', jsonb_build_array(
          jsonb_build_object('leg', 'both', 'ride_id', v_join_ride_id, 'car_mode', 'passenger'))),
        'ASK_TO_JOIN_TEMP_CAR', array[v_join_owner], 'ask_to_join');
    end if;
  end if;

  -- REQ §13.135 (c): a private car chosen in the form takes the round trip at once, in any week phase (never another
  -- car instead); a busy car refuses the submit so the member can pick other times.
  -- REQ §13.206: a one-way trip too - the ride ends after the route time and leaves the car at the destination, so
  -- both ends must be list places (place_request_on_car then also checks the car stands at the origin).
  if v_preferred_car_id is not null and v_trip_type in ('round_trip', 'one_way') and v_series_id is null and v_join_ride_id is null
     and coalesce((payload->>'reserve_missing_driver')::boolean, false) = false
     and exists (select 1 from public.cars c join public.requests q on q.id = v_request_id
                 where c.id = v_preferred_car_id and c.type = 'temporary' and c.status = 'active'
                   and c.owner_id in (v_actor, q.requester_id, q.filed_by)) then
    v_own_car := v_preferred_car_id;
    if v_depart_at < now() then raise exception 'ride_in_past' using errcode = 'P0001'; end if;
    v_own_turnaround := coalesce(public.required_turnaround_minutes(v_department_id, v_week_start), 30);
    v_own_end := v_return_at;
    if v_trip_type = 'one_way' then
      if v_depart_at is null or exists (select 1 from public.requests q where q.id = v_request_id
                                         and (q.origin_id is null or q.destination_id is null)) then
        raise exception 'own_car_one_way_place' using errcode = 'P0001';
      end if;
      v_own_end := greatest(public._round_up_ride_end(v_depart_at,
        v_depart_at + make_interval(mins => greatest(coalesce(public.request_leg_route_minutes(v_request_id, 'out'), 30), 0))),
        v_depart_at + interval '15 minutes');
    end if;
    if exists (select 1 from public.rides r where r.car_id = v_own_car and r.status <> 'cancelled'
               and not exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = v_request_id)
               and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_depart_at, v_own_end + make_interval(mins => v_own_turnaround), '[)'))
       or exists (select 1 from public.car_maintenance_blocks b where b.car_id = v_own_car
               and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_depart_at, v_own_end, '[)')) then
      raise exception 'own_car_not_free' using errcode = 'P0001';
    end if;
  end if;

  -- Placement on submit (REQ §13.93/§13.94): only round_trip and an explicit one_way ("I take the
  -- car") go through try_auto_approve() once a week is published/live. Every drop_off, with or
  -- without a pickup, is two separate trips for the Sadran/solver: waitlisted in a live week.
  -- REQ §13.176 (owner 2026-11-01): an overlap with the member's own ride or request is a question - for whoever files
  -- it, the member or someone on their behalf - never a quiet trip to the waiting list for the Sadran. Confirmed
  -- (`overlap_confirmed`), the request is placed like any other. Inside an edit's trial placement nobody is asked yet:
  -- the trial notes it (`overlap_unasked`) and the edit asks only when the new hours would really be placed.
  if v_own_overlap and not v_overlap_confirmed
     and v_week.phase in ('published', 'live') and v_trip_type in ('round_trip', 'one_way') then
    if coalesce(current_setting('app.edit_probe_inner', true), 'off') = 'on' then
      v_overlap_unasked := true;
    else
      perform public._ask_request_overlap(v_requester_id, v_depart_at, v_return_at, v_request_id);
    end if;
  end if;
  if coalesce((payload->>'reserve_missing_driver')::boolean,false) then
    v_auto_result:=public.reserve_live_one_way_slot(v_request_id);
    perform public.enqueue_notification(s.profile_id,'waitlisted_request',v_department_id,v_week_start,
      jsonb_build_object('requestId',v_request_id::text),jsonb_build_object('request_id',v_request_id,'ride_id',v_auto_result->>'ride_id'),
      format('waitlisted_request:%s',v_request_id)) from public.sadranim_of(v_department_id,v_week_start) as s(profile_id)
    where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on';
  elsif v_own_car is not null then
    -- REQ §13.135 (c): on the chosen private car (pending proposals of the request are settled like place_on_own_car).
    perform set_config('app.audit_reason', 'own_car_from_form', true);
    update public.proposals p set status = 'withdrawn'
    where p.status in ('draft', 'sent')
      and (p.request_id = v_request_id or exists (select 1 from public.proposal_parties pp where pp.proposal_id = p.id and pp.request_id = v_request_id));
    v_edit_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    v_edit_ride := public.place_request_on_car(v_request_id, v_own_car, false, v_actor, null, null, null, 'OWN_CAR');
    perform set_config('app.system_status_transition', v_edit_prev_sys, true);
    v_auto_result := jsonb_build_object('status', 'assigned', 'reason', 'OWN_CAR', 'ride_id', v_edit_ride, 'car_id', v_own_car);
    select full_name into v_own_by from public.profiles where id = v_actor;
    perform public.enqueue_notification(s.profile_id, 'outcome_changed', v_department_id, v_week_start,
      jsonb_build_object('byName', coalesce(v_own_by, ''), 'route', coalesce(public.request_route_label(v_request_id), ''),
        'day', public.day_date_label(v_depart_at), 'car', (select name from public.cars where id = v_own_car)),
      jsonb_build_object('variant', 'own_car_placed', 'request_id', v_request_id, 'ride_id', v_edit_ride,
        'url', format('/sadran/%s/%s/board', v_department_id, v_week_start)),
      format('own_car_placed:%s:%s:%s', v_request_id, s.profile_id, clock_timestamp()))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
    where s.profile_id is distinct from v_actor and v_week.phase in ('published', 'live');
  elsif v_series_id is not null then
    -- REQ §13.77: placement is all-or-nothing across every leg — try_auto_approve_series()
    -- is called once by submit_series_request() after the last leg exists.
    v_auto_result := null;
  elsif v_join_ride_id is not null and v_week.phase in ('published', 'live') then
    -- R3B10: the member asked for THIS ride; no other car is ever picked for them.
    if v_week.phase = 'live' then
      perform set_config('app.system_status_transition', 'on', true);
      update public.requests set status = 'waitlisted', status_reason = 'ASK_TO_JOIN' where id = v_request_id;
      perform set_config('app.system_status_transition', 'off', true);
    end if;
    if v_join_car_type is distinct from 'temporary' then
      perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text, 'rideLabel', public._ask_to_join_ride_label(v_join_ride_id)),
        jsonb_build_object('request_id', v_request_id, 'variant', 'ask_to_join'),
        format('waitlisted_request:%s', v_request_id))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
      where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on';
    end if;
    v_auto_result := jsonb_build_object('status', case when v_week.phase = 'live' then 'waitlisted' else 'submitted' end,
      'reason', 'ASK_TO_JOIN');
  elsif v_week.phase in ('published','live')
    and v_trip_type in ('round_trip', 'one_way') then
    -- REQ §13.111 (a): the strict placement (it already prefers a large-trunk car) is tried first; only when it finds
    -- no car and a car without a large trunk would take the request is the member asked ("לשבץ בכל זאת?").
    if v_ask_small and (public.request_needs_large_trunk(v_request_id) or public.request_needs_tow_hitch(v_request_id)) then
      v_small_car := public._small_trunk_probe(v_request_id);
      if v_small_car is not null then
        if not v_allow_small then
          raise exception 'needs_large_trunk' using errcode = 'P0001', detail = public._small_trunk_detail(array[v_request_id], v_small_car);
        end if;
        update public.requests set luggage_waived_at = now(), luggage_waived_by = v_actor where id = v_request_id;
        v_waived_here := true;
      end if;
    end if;
    -- REQ §13.127 (c): an edited round trip that was booked on a private car goes back on that car when it still
    -- fits (try_auto_approve only knows shared cars); place_request_on_car checks the owner's consent.
    -- REQ §13.206: so does a one-way trip.
    if v_published_edit and v_old_edit_car is not null
       and exists (select 1 from public.cars c where c.id = v_old_edit_car and c.type = 'temporary') then
      v_edit_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
      perform set_config('app.system_status_transition', 'on', true);
      begin
        v_edit_ride := public.place_request_on_car(v_request_id, v_old_edit_car, false, v_actor, null, null, null, 'OWN_CAR');
      exception when others then
        v_edit_ride := null;
      end;
      perform set_config('app.system_status_transition', v_edit_prev_sys, true);
      if v_edit_ride is not null then
        v_auto_result := jsonb_build_object('status', 'assigned', 'reason', 'OWN_CAR', 'ride_id', v_edit_ride, 'car_id', v_old_edit_car);
      end if;
    end if;
    if v_auto_result is null then
      v_auto_result := public.try_auto_approve(v_request_id);
    end if;
    if v_waived_here and coalesce(v_auto_result ->> 'status', '') <> 'assigned' then
      update public.requests set luggage_waived_at = null, luggage_waived_by = null where id = v_request_id;
    end if;
  elsif v_week.phase in ('published', 'live') and v_trip_type = 'drop_off' and v_keep_car and v_series_id is null then
    -- REQ §13.126 g: both legs on ONE car, connected (assert_car_chain → connect_drop_off_legs keeps the car waiting at the
    -- destination for a keep-car request); the old booking's car first, then the preferred one. None takes both legs on
    -- one car -> the waiting list (block below).
    v_edit_ride := null;
    v_edit_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    for v_keep_car_id in
      select c.id from public.cars c
      where c.department_id = v_department_id and c.status = 'active' and c.type = 'shared'
      order by (c.id = v_old_edit_car) desc nulls last, (c.id = v_preferred_car_id) desc nulls last, c.id
    loop
      begin
        v_edit_ride := public.place_request_on_car(v_request_id, v_keep_car_id, false, v_actor, null, null, null, 'AUTO_APPROVED_FREE_CAR');
        if coalesce(array_length(public.request_covered_legs(v_request_id), 1), 0) < 2
           or exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                      where rr.request_id = v_request_id and r.status <> 'cancelled' and r.car_id <> v_keep_car_id) then
          raise exception 'keep_car_both_legs' using errcode = 'PXKC1';
        end if;
        exit;
      exception when others then
        v_edit_ride := null;
      end;
    end loop;
    perform set_config('app.system_status_transition', v_edit_prev_sys, true);
    if v_edit_ride is not null then
      v_auto_result := jsonb_build_object('status', 'assigned', 'reason', 'AUTO_APPROVED_FREE_CAR', 'ride_id', v_edit_ride, 'car_id', v_keep_car_id);
    else
      perform set_config('app.system_status_transition', 'on', true);
      update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_NO_CAR' where id = v_request_id;
      perform set_config('app.system_status_transition', v_edit_prev_sys, true);
      v_auto_result := jsonb_build_object('status', 'waitlisted', 'reason', 'WAITLISTED_NO_CAR');
    end if;
  elsif v_published_edit and v_trip_type = 'drop_off' then
    -- Owner 2026-10-11: a member's edit into (or of) a הקפצה on a published/live day is placed when a car
    -- is free — the old booking's car first, then any free shared car — like the Sadran's trip-type switch
    -- (R8B12, REQ §13.117). Only when no car takes it does it go to the waiting list (block below).
    v_edit_ride := null;
    -- place_request_on_car moves the member's own request to `assigned` — a system step (requests_status_guard).
    v_edit_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    if v_old_edit_car is not null then
      begin
        v_edit_ride := public.place_request_on_car(v_request_id, v_old_edit_car, false, v_actor, null, null, null, 'AUTO_APPROVED_FREE_CAR');
      exception when others then
        v_edit_ride := null;
      end;
    end if;
    if v_edit_ride is null then
      v_edit_ride := public.place_request_on_any_free_car(v_request_id, v_actor, null, null, 'AUTO_APPROVED_FREE_CAR');
    end if;
    perform set_config('app.system_status_transition', v_edit_prev_sys, true);
    if v_edit_ride is not null then
      v_auto_result := jsonb_build_object('status', 'assigned', 'reason', 'AUTO_APPROVED_FREE_CAR', 'ride_id', v_edit_ride,
        'car_id', (select car_id from public.rides where id = v_edit_ride));
    end if;
  elsif v_week.phase in ('published', 'live') and v_trip_type = 'drop_off' and v_request_id is not null
    and public.is_day_public(v_department_id, v_week_start, (coalesce(v_depart_at, v_return_at) at time zone 'Asia/Jerusalem')::date)
    and public.place_request_on_any_free_car_as_system(v_request_id, v_actor) is not null then
    -- REQ §13.192 (HK1, owner 2026-11-07): a NEW הקפצה on a published day is placed like an edit into one (owner
    -- 2026-10-11): on a free shared car, else the waiting list (the branch below). A ride nobody drives yet is
    -- `needs_driver` (the request waits as UNMET_NEEDS_DRIVER) and the driver-wanted flow (REQ §13.170) finds one.
    select r.id, r.car_id, coalesce(bool_or(r.needs_driver) over (), false) into v_edit_ride, v_keep_car_id, v_needs_driver
    from public.ride_requests rr join public.rides r on r.id = rr.ride_id
    where rr.request_id = v_request_id and r.status <> 'cancelled' order by r.starts_at, r.id limit 1;
    if v_needs_driver then
      v_auto_result := jsonb_build_object('status', 'waitlisted', 'reason', 'UNMET_NEEDS_DRIVER', 'needs_driver', true,
        'ride_id', v_edit_ride, 'car_id', v_keep_car_id);
      perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id, 'ride_id', v_edit_ride),
        format('waitlisted_request:%s', v_request_id))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
      where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on'
        and s.profile_id is distinct from v_actor;
    else
      v_auto_result := jsonb_build_object('status', 'assigned', 'reason', 'AUTO_APPROVED_FREE_CAR', 'needs_driver', false,
        'ride_id', v_edit_ride, 'car_id', v_keep_car_id);
    end if;
  elsif v_week.phase = 'live' then
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_ONE_WAY' where id = v_request_id;
    perform set_config('app.system_status_transition', 'off', true);
    perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
      jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
      format('waitlisted_request:%s', v_request_id))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
    where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on';
    v_auto_result := jsonb_build_object('status', 'waitlisted', 'reason', 'WAITLISTED_ONE_WAY');
  end if;

  -- REQ §13.101 (f): an edited request on a published/live day that found no car goes to the waiting list.
  if v_published_edit and v_request_id is not null and coalesce(v_auto_result ->> 'status', '') <> 'assigned' then
    select status into v_status from public.requests where id = v_request_id;
    if v_status is distinct from 'waitlisted' then
      perform set_config('app.system_status_transition', 'on', true);
      update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_EDITED' where id = v_request_id;
      perform set_config('app.system_status_transition', 'off', true);
      -- R2Q1: an edited request joins an open overlapping group exactly like a late one.
      if public.join_waitlist_group(v_request_id) is not null then
        v_auto_result := coalesce(v_auto_result, '{}'::jsonb) || jsonb_build_object('reason', 'WAITLISTED_CONTESTED');
      end if;
      perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
        format('waitlisted_request:%s', v_request_id))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
    where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on'
      and s.profile_id is distinct from (select auth.uid());
      v_auto_result := coalesce(v_auto_result, '{}'::jsonb)
        || jsonb_build_object('status', 'waitlisted', 'reason', coalesce(v_auto_result ->> 'reason', 'WAITLISTED_EDITED'));
    end if;
    -- R6B13: the editor is told the edit was saved and the request now waits (nothing was said before).
    -- REQ §13.169 (c): a requester who did not make the form's edit gets the riders' `ride_edited` notice instead.
    if not v_form_notice or v_requester_id = v_actor then
    perform public.enqueue_notification(v_requester_id, 'outcome_changed', v_department_id, v_week_start,
      '{}'::jsonb, jsonb_build_object('variant', 'edit_waitlisted', 'request_id', v_request_id),
      format('edit_waitlisted:%s:%s', v_request_id, clock_timestamp()));
    end if;
  end if;

  if v_is_late and coalesce(v_auto_result->>'status','') <> 'assigned' and coalesce(v_series_index, 1) = 1 then
    v_late_variant := case coalesce(v_auto_result->>'reason', '')
      when 'WAITLISTED_CONTESTED' then 'late_contested'
      when 'DUPLICATE_OVERLAP' then 'late_duplicate'
      when 'WAITLISTED_NO_CAR' then 'late_waitlisted'
      else case when coalesce(v_auto_result->>'status', '') = 'waitlisted' then 'late_waitlisted' else null end end;
    -- R5U5: a late ask-to-join is an ask-to-join (naming the ride asked), not a plain late request.
    if v_join_ride_id is not null then v_late_variant := 'ask_to_join'; end if;
    perform public.enqueue_notification(s.profile_id, 'late_request', v_department_id, v_week_start,
      jsonb_build_object('requestId', v_request_id::text)
        || case when v_join_ride_id is not null then jsonb_build_object('rideLabel', public._ask_to_join_ride_label(v_join_ride_id)) else '{}'::jsonb end,
      jsonb_build_object('request_id', v_request_id) || case when v_late_variant is null then '{}'::jsonb else jsonb_build_object('variant', v_late_variant) end,
      format('late_request:%s', v_request_id))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
    -- R13B15: the Sadran who made the change is not told about it.
    where s.profile_id is distinct from (select auth.uid());
  end if;
  perform set_config('app.late_request_notice', 'off', true);

  -- R2B20: a post-publish edit that was placed straight away is confirmed to the member.
  perform set_config('app.edit_prefer_car', '', true);
  perform set_config('app.car_stays_away', '', true);
  perform set_config('app.edit_kept_rides', '', true);
  if v_published_edit and coalesce(v_auto_result->>'status', '') = 'assigned' then
    -- R3B14: when the car changed, the confirmation says old -> new including the car.
    -- REQ §13.169 (c): only to a requester who made the form's edit themselves; the other riders get `ride_edited`.
    if v_form_notice and v_requester_id is distinct from v_actor then
      null;
    elsif v_old_edit_car is not null and (v_auto_result->>'car_id') is not null and (v_auto_result->>'car_id')::uuid <> v_old_edit_car then
      perform public.enqueue_notification(v_requester_id, 'outcome_changed', v_department_id, v_week_start,
        jsonb_build_object('changeLine', public._frag('change.car', jsonb_build_object(
          'newCar', coalesce((select name from public.cars where id = (v_auto_result->>'car_id')::uuid), ''),
          'oldCar', coalesce((select name from public.cars where id = v_old_edit_car), '')))),
        jsonb_build_object('variant', 'car_changed', 'request_id', v_request_id, 'ride_id', v_auto_result->>'ride_id'),
        format('edit_applied:%s:%s', v_request_id, clock_timestamp()));
    else
      perform public.enqueue_notification(v_requester_id, 'outcome_changed', v_department_id, v_week_start,
        '{}'::jsonb, jsonb_build_object('variant', 'edit_applied', 'request_id', v_request_id, 'ride_id', v_auto_result->>'ride_id'),
        format('edit_applied:%s:%s', v_request_id, clock_timestamp()));
    end if;
    -- R16B12: the member companions ride at the new hours too - each is told (never the person who edited).
    -- REQ §13.169 (c): a save from the request form tells them with `ride_edited` instead.
    if not v_form_notice and (v_existing.depart_at, v_existing.return_at) is distinct from (v_depart_at, v_return_at) then
      for v_companion in select c.profile_id from public.request_companions c
                         where c.request_id = v_request_id and c.profile_id is distinct from v_actor loop
        perform public.enqueue_notification(v_companion, 'outcome_changed', v_department_id, v_week_start,
          jsonb_build_object('byName', coalesce((select full_name from public.profiles where id = v_requester_id), ''),
            'route', coalesce(public.request_route_label(v_request_id), ''),
            'day', public.day_date_label(coalesce(v_existing.depart_at, v_existing.return_at)),
            'timeChange', public._time_change_line(v_existing.depart_at, v_existing.return_at, v_depart_at, v_return_at),
            'carLine', ''),
          jsonb_build_object('variant', 'time_changed', 'request_id', v_request_id, 'ride_id', v_auto_result->>'ride_id'),
          format('companion_time_changed:%s:%s:%s', v_request_id, v_companion, clock_timestamp()));
      end loop;
    end if;
  end if;

  -- R14B8: /my reads submitted until the day is published (REQ §13.109 a), so a member's form must not announce
  -- "you got car X" for it: the result keeps its fields (tests, the Sadran) and says `outcome_hidden`; the form then
  -- shows the plain "request sent" confirmation.
  if not coalesce(v_can_manage, false) and v_auto_result ? 'status'
     and v_auto_result->>'status' in ('assigned', 'merged', 'waitlisted', 'denied', 'external')
     and not public.is_day_public(v_department_id, v_week_start,
       (coalesce(v_depart_at, v_return_at) at time zone 'Asia/Jerusalem')::date) then
    v_auto_result := v_auto_result || jsonb_build_object('outcome_hidden', true);
  end if;

  return jsonb_build_object('request_id', v_request_id, 'is_late', v_is_late, 'warnings', v_warnings, 'overlaps', v_overlaps)
    || case when v_overlap_unasked then jsonb_build_object('overlap_unasked', true) else '{}'::jsonb end
    || coalesce(v_auto_result, '{}'::jsonb);
end;
$function$;

revoke all on function public.set_request_trip_type(uuid, public.trip_type, integer, boolean, boolean) from public;
grant execute on function public.set_request_trip_type(uuid, public.trip_type, integer, boolean, boolean) to authenticated, service_role;
