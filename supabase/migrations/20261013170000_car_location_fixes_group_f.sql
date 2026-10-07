-- QA run 6 group F (R6B4, R6B6 support, R6B11, REQ 105 d): car location, chain and shape fixes. Full create or replace.

CREATE OR REPLACE FUNCTION "public"."place_request_on_car"("p_request_id" "uuid", "p_car_id" "uuid", "p_manual" boolean, "p_actor" "uuid", "p_named_driver" "uuid", "p_dep" timestamp with time zone, "p_ret" timestamp with time zone, "p_reason" "text" DEFAULT 'PROPOSAL_APPLIED'::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
      v_dur := greatest(15, ceil((2 * v_travel + greatest(v_dwell, 0)) / 15.0)::int * 15);
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
$$;

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

CREATE OR REPLACE FUNCTION "public"."car_next_ride_origin"("_car" "uuid", "_after" timestamp with time zone) RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select r.origin_id from public.rides r
  where r.car_id = _car and r.status <> 'cancelled' and not r.planning_conflict
    and (not r.auto_relocation or r.driver_id is not null or r.pin_reason = 'CAR_MOVE')   -- R6B6: a car move decides where the car is
    and not public.ride_is_reservation(r.id)
    and r.starts_at >= _after
  order by r.starts_at asc limit 1;
$$;

CREATE OR REPLACE FUNCTION "public"."connect_drop_off_legs"("_car" "uuid", "_week" "date") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_dept uuid; v_turnaround interval; c record; q public.requests%rowtype; v_driver uuid;
  v_os timestamptz; v_oe timestamptz; v_rs timestamptz; v_re timestamptz; v_gap smallint;
  v_t_out int; v_t_ret int; v_prev_flag text;
begin
  select department_id into v_dept from public.cars where id = _car;
  if v_dept is null then return; end if;
  v_turnaround := make_interval(mins => coalesce(public.required_turnaround_minutes(v_dept, _week), 30));

  for c in
    select o.request_id, o.ride_id as out_ride, rt.ride_id as ret_ride, (o.manual or rt.manual) as manual
    from (
      select rr.request_id, r.id as ride_id, rr.car_mode, (r.pin_reason = 'SADRAN_MANUAL') as manual
      from public.rides r join public.ride_requests rr on rr.ride_id = r.id
      where r.car_id = _car and r.week_start = _week and r.status <> 'cancelled' and not r.planning_conflict
        and not r.auto_relocation and r.pin_reason is distinct from 'SADRAN_MOVED' and rr.leg = 'out'
        and (select count(*) from public.ride_requests x where x.ride_id = r.id) = 1
    ) o
    join (
      select rr.request_id, r.id as ride_id, rr.car_mode, (r.pin_reason = 'SADRAN_MANUAL') as manual
      from public.rides r join public.ride_requests rr on rr.ride_id = r.id
      where r.car_id = _car and r.week_start = _week and r.status <> 'cancelled' and not r.planning_conflict
        and not r.auto_relocation and r.pin_reason is distinct from 'SADRAN_MOVED' and rr.leg = 'return'
        and (select count(*) from public.ride_requests x where x.ride_id = r.id) = 1
    ) rt on rt.request_id = o.request_id
    join public.requests qq on qq.id = o.request_id
    where qq.trip_type = 'drop_off' and qq.trip_shape = 'round_trip'
      and qq.depart_at is not null and qq.return_at is not null
      and qq.origin_id is not null and qq.destination_id is not null
      and (o.car_mode <> 'relay' or rt.car_mode <> 'relay')
    order by qq.depart_at, o.request_id
  loop
    select * into q from public.requests where id = c.request_id;
    v_driver := public.eligible_leg_driver(q.id);
    if v_driver is null then continue; end if; -- a non-driver's legs stay chauffeur rides

    v_t_out := greatest(coalesce(public.request_leg_route_minutes(q.id, 'out'), 30), 0);
    v_t_ret := greatest(coalesce(public.request_leg_route_minutes(q.id, 'return'), 30), 0);
    v_os := q.depart_at;
    v_oe := greatest(public._round_up_ride_end(v_os, v_os + make_interval(mins => v_t_out)), v_os + interval '15 minutes');
    v_re := q.return_at;
    v_rs := to_timestamp(floor(extract(epoch from (v_re - make_interval(mins => v_t_ret))) / 900) * 900);
    if v_rs < v_oe then continue; end if;
    -- REQ §13.103 a / §13.104 a: the wait is needed by others -> two legs, the car returns. A Sadran's own
    -- (manual) placement of either leg is an explicit decision and is never undone by this rule (R4B2).
    -- R5B8 (REQ §13.105): a SHORT wait (<= 2 x turnaround, the §13.104 b threshold) never counts as needed elsewhere:
    -- two chauffeur wraps burn more car time than the wait and leave a member who can drive with two driverless rides.
    if not c.manual and v_rs - v_oe > 2 * v_turnaround
       and public.car_wait_needed_elsewhere(q.department_id, q.week_start, v_oe, v_rs, array[q.id]) then
      continue;
    end if;

    -- the car must be at the origin when the out leg leaves
    if coalesce((select r.destination_id from public.rides r
                 where r.car_id = _car and r.status <> 'cancelled' and r.starts_at <= v_os and r.id not in (c.out_ride, c.ret_ride)
                   and not public.ride_is_reservation(r.id)
                 order by r.starts_at desc limit 1), public.car_base_location(_car)) is distinct from q.origin_id then continue; end if;
    -- no collision with other rides of the car; between the legs only trips that start and end at the destination
    if exists (
      select 1 from public.rides x
      where x.car_id = _car and x.id not in (c.out_ride, c.ret_ride) and x.status <> 'cancelled' and not x.planning_conflict
        and (tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_os, v_oe + v_turnaround, '[)')
          or tstzrange(x.starts_at, x.blocked_until, '[)') && tstzrange(v_rs, v_re + v_turnaround, '[)')
          or (x.starts_at >= v_oe and x.starts_at < v_rs
              and not public.ride_is_reservation(x.id)
              and (x.origin_id is distinct from q.destination_id or x.destination_id is distinct from q.destination_id)))
    ) then continue; end if;

    v_gap := case when v_rs - v_oe < v_turnaround then (extract(epoch from (v_rs - v_oe)) / 60)::smallint end;

    update public.rides set origin_id = q.origin_id, destination_id = q.destination_id,
      starts_at = v_os, ends_at = v_oe, needs_driver = false, driver_id = v_driver,
      turnaround_override_minutes = v_gap,
      pin_reason = case when pin_reason = 'MISSING_DRIVER' then 'CONNECTED_DROP_OFF' else pin_reason end
    where id = c.out_ride;
    update public.rides set origin_id = q.destination_id, destination_id = q.origin_id,
      starts_at = v_rs, ends_at = v_re, needs_driver = false, driver_id = v_driver,
      pin_reason = case when pin_reason = 'MISSING_DRIVER' then 'CONNECTED_DROP_OFF' else pin_reason end
    where id = c.ret_ride;
    update public.ride_requests set role = 'driver', car_mode = 'relay'
    where request_id = q.id and ride_id in (c.out_ride, c.ret_ride);

    v_prev_flag := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'assigned', status_reason = 'RELAY_CONNECTED'
    where id = q.id and status is distinct from 'assigned';
    perform set_config('app.system_status_transition', v_prev_flag, true);
  end loop;
end $$;

CREATE OR REPLACE FUNCTION "public"."edit_ride_before_planning"("p_ride" "jsonb", "p_expected_version" integer DEFAULT NULL::integer) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_prev_reason text;
  v_id uuid := nullif(p_ride->>'id', '')::uuid;
  v_dept uuid := (p_ride->>'department_id')::uuid;
  v_week date := (p_ride->>'week_start')::date;
  v_existing public.rides%rowtype;
  v_manage boolean;
  v_served jsonb;
  v_prev_status public.request_status; v_rq_requester uuid;
  v_old_requests uuid[];
  v_needs_driver boolean;
  v_override smallint;
  v_car_row public.cars%rowtype;
  v_one jsonb; v_req public.requests%rowtype; v_leg public.ride_leg; v_min int;
  v_s timestamptz; v_e timestamptz; v_day date;
begin
  if not public.is_approved() then raise exception 'not_authorized'; end if;
  if v_id is not null then
    select * into v_existing from public.rides where id = v_id for update;
    if not found then raise exception 'ride_not_found'; end if;
    if v_dept is distinct from v_existing.department_id or v_week is distinct from v_existing.week_start then raise exception 'not_authorized'; end if;
    if p_expected_version is null or v_existing.version <> p_expected_version then perform public.raise_stale_version(); end if;
    if v_existing.status = 'cancelled' then raise exception 'ride_not_found'; end if;
  end if;
  v_manage := public.can_manage_week(v_dept,v_week);
  if exists (select 1 from public.weeks where department_id=v_dept and week_start=v_week and phase='archived') then raise exception 'week_archived'; end if;
  if not v_manage then
    if v_id is null or v_existing.driver_id is distinct from (select auth.uid()) or not public.is_week_public(v_dept,v_week) then raise exception 'not_authorized'; end if;
    if (p_ride->>'starts_at')::timestamptz <= now() then raise exception 'ride_in_past'; end if;
    if (p_ride ? 'driver_id' and (p_ride->>'driver_id')::uuid is distinct from v_existing.driver_id)
      or (p_ride ? 'origin_id' and (p_ride->>'origin_id')::uuid is distinct from v_existing.origin_id)
      or (p_ride ? 'destination_id' and (p_ride->>'destination_id')::uuid is distinct from v_existing.destination_id)
      or ((p_ride->>'starts_at')::timestamptz at time zone 'Asia/Jerusalem')::date <> (v_existing.starts_at at time zone 'Asia/Jerusalem')::date
      or exists (select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=v_id and (q.requester_id <> (select auth.uid()) or rr.car_mode <> 'keep'))
    then raise exception 'not_authorized'; end if;
  end if;
  if not exists (select 1 from public.cars where id=(p_ride->>'car_id')::uuid and status='active' and department_id=v_dept) then raise exception 'car_unavailable'; end if;
  -- REQ §13.99: only the owner puts requests on a private (temporary) car.
  select * into v_car_row from public.cars where id=(p_ride->>'car_id')::uuid;
  if v_car_row.type='temporary' and v_car_row.owner_id is distinct from (select auth.uid()) then
    if v_id is not null and v_existing.car_id is distinct from v_car_row.id then
      raise exception 'private_car_owner_only' using errcode='P0001';  -- moving a ride onto it
    elsif v_id is null and (jsonb_array_length(coalesce(p_ride->'served','[]'))=0 or exists(
        select 1 from jsonb_array_elements(p_ride->'served') s join public.requests q on q.id=(s->>'request_id')::uuid
        where q.requester_id is distinct from v_car_row.owner_id)) then
      raise exception 'private_car_owner_only' using errcode='P0001';  -- a new ride that is not the owner's own
    elsif v_id is not null and v_manage and p_ride ? 'served' and exists(
        select 1 from jsonb_array_elements(p_ride->'served') s join public.requests q on q.id=(s->>'request_id')::uuid
        where q.requester_id is distinct from v_car_row.owner_id
          and not exists(select 1 from public.ride_requests rr where rr.ride_id=v_id and rr.request_id=q.id)) then
      raise exception 'private_car_owner_only' using errcode='P0001';  -- adding someone else's request
    end if;
  end if;
  -- REQ §13.100 QB5: a single chauffeur leg of a drop-off request keeps a chauffeur-length window.
  if v_manage and jsonb_typeof(p_ride->'served')='array' and jsonb_array_length(p_ride->'served')=1
     and coalesce((p_ride->>'needs_driver')::boolean,false) then
    v_one:=p_ride->'served'->0;
    select * into v_req from public.requests where id=(v_one->>'request_id')::uuid;
    v_leg:=coalesce((v_one->>'leg')::public.ride_leg,'both');
    if v_req.id is not null and v_req.trip_type='drop_off' and v_leg in ('out','return')
       and coalesce(v_one->>'car_mode','')='chauffeur' then
      v_min:=public.chauffeur_ride_minutes(v_req.id,v_leg);
      v_s:=(p_ride->>'starts_at')::timestamptz; v_e:=(p_ride->>'ends_at')::timestamptz;
      v_day:=(v_s at time zone 'Asia/Jerusalem')::date;
      if extract(epoch from (v_e-v_s))/60 < v_min then
        if v_leg='out' then
          v_e:=v_s+make_interval(mins=>v_min);
          if (v_e at time zone 'Asia/Jerusalem')::date<>v_day then v_e:=((v_day+time '23:59') at time zone 'Asia/Jerusalem'); end if;
        else
          v_s:=v_e-make_interval(mins=>v_min);
          if (v_s at time zone 'Asia/Jerusalem')::date<>v_day then v_s:=(v_day::timestamp at time zone 'Asia/Jerusalem'); end if;
        end if;
        p_ride:=p_ride||jsonb_build_object('starts_at',v_s,'ends_at',v_e);
      end if;
    end if;
  end if;
  v_needs_driver:=case when v_manage then coalesce((p_ride->>'needs_driver')::boolean,v_existing.needs_driver,false) else false end;
  perform set_config('app.audit_reason','edit_ride',true);
  if v_manage then
    v_override:=public.prepare_manual_ride_window((p_ride->>'car_id')::uuid,v_week,(p_ride->>'starts_at')::timestamptz,(p_ride->>'ends_at')::timestamptz,v_id);
  end if;
  if v_id is null then
    insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by,notes,needs_driver,turnaround_override_minutes)
    values(v_dept,v_week,(p_ride->>'car_id')::uuid,(p_ride->>'starts_at')::timestamptz,(p_ride->>'ends_at')::timestamptz,
      (p_ride->>'origin_id')::uuid,(p_ride->>'destination_id')::uuid,nullif(p_ride->>'driver_id','')::uuid,
      case when public.is_week_public(v_dept,v_week) then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
      true,coalesce(p_ride->>'pin_reason','SADRAN_MANUAL'),(select auth.uid()),nullif(trim(p_ride->>'notes'),''),v_needs_driver,v_override) returning id into v_id;
  else
    update public.rides set needs_driver=v_needs_driver,turnaround_override_minutes=v_override,car_id=(p_ride->>'car_id')::uuid,starts_at=(p_ride->>'starts_at')::timestamptz,ends_at=(p_ride->>'ends_at')::timestamptz,
      origin_id=coalesce((p_ride->>'origin_id')::uuid,origin_id),destination_id=coalesce((p_ride->>'destination_id')::uuid,destination_id),
      driver_id=case when v_manage and p_ride ? 'driver_id' then nullif(p_ride->>'driver_id','')::uuid else driver_id end,
      notes=case when v_manage and p_ride ? 'notes' then nullif(trim(p_ride->>'notes'),'') else notes end,
      overflow_allowed=case when v_manage then coalesce((p_ride->>'overflow_allowed')::boolean,overflow_allowed) else overflow_allowed end,
      overnight_ack_by=case when v_manage and (p_ride->>'overnight_ack')::boolean then (select auth.uid()) else overnight_ack_by end,
      overnight_ack_at=case when v_manage and (p_ride->>'overnight_ack')::boolean then now() else overnight_ack_at end,
      is_pinned=case when v_needs_driver then true when v_manage then coalesce((p_ride->>'is_pinned')::boolean,true) else true end,pin_reason=case
        -- R6B11: moving a chauffeur leg to another car keeps its shape (whatever pin reason the board echoes back);
        -- auto-connecting (connect_drop_off_legs) skips it. Joining the legs is the Sadran's explicit join_drop_off_legs.
        when v_manage and v_existing.car_id is distinct from (p_ride->>'car_id')::uuid
          and exists(select 1 from public.ride_requests rr where rr.ride_id=v_id and rr.car_mode='chauffeur') then 'SADRAN_MOVED'
        else coalesce(p_ride->>'pin_reason',case when v_manage then 'SADRAN_EDIT' else 'MEMBER_EDIT' end) end
    where id=v_id;
  end if;
  if v_manage and p_ride ? 'served' then
    select array_agg(request_id) into v_old_requests from public.ride_requests where ride_id=v_id;
    delete from public.ride_requests where ride_id=v_id;
    for v_served in select * from jsonb_array_elements(p_ride->'served') loop
      if exists (select 1 from public.rides where id=v_id and driver_id is null and not needs_driver) then raise exception 'reservation_cannot_serve_requests'; end if;
      select status, requester_id, status_reason into v_prev_status, v_rq_requester, v_prev_reason from public.requests where id=(v_served->>'request_id')::uuid;
      insert into public.ride_requests(ride_id,request_id,role,leg,car_mode,detour_minutes)
      values(v_id,(v_served->>'request_id')::uuid,(v_served->>'role')::public.ride_role,
        coalesce((v_served->>'leg')::public.ride_leg,'both'),(v_served->>'car_mode')::public.leg_car_mode,coalesce((v_served->>'detour_minutes')::smallint,0));
      update public.requests set status=case when v_needs_driver then 'waitlisted'::public.request_status when v_served->>'role'='driver' then 'assigned'::public.request_status else 'merged'::public.request_status end,status_reason=case when v_needs_driver then 'UNMET_NEEDS_DRIVER' else 'SADRAN_ASSIGNED' end
      where id=(v_served->>'request_id')::uuid;
      if v_manage and not v_needs_driver and v_prev_status in ('waitlisted','submitted','proposed')
         and v_rq_requester is distinct from (select auth.uid())
         -- R4B8: not when the request was already on this ride, or already placed and only awaiting a driver
         and not ((v_served->>'request_id')::uuid = any(coalesce(v_old_requests,'{}'::uuid[])))
         and v_prev_reason is distinct from 'UNMET_NEEDS_DRIVER'
         and public.is_day_public(v_dept,v_week,((p_ride->>'starts_at')::timestamptz at time zone 'Asia/Jerusalem')::date) then
        perform public.enqueue_notification(v_rq_requester,'outcome_changed',v_dept,v_week,'{}'::jsonb,
          jsonb_build_object('variant','edit_applied','request_id',(v_served->>'request_id')::uuid,'ride_id',v_id),
          format('placed_by_sadran:%s:%s',(v_served->>'request_id')::uuid,v_id));
      end if;
    end loop;
    update public.requests q set status='waitlisted',status_reason='SADRAN_UNASSIGNED'
    where q.id=any(v_old_requests) and not exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=q.id and r.status<>'cancelled');
  end if;
  perform public.assert_ride_driver(v_id);
  if v_manage then
    perform public.refresh_car_turnarounds((p_ride->>'car_id')::uuid,v_week);
    if v_existing.car_id is not null and v_existing.car_id<>(p_ride->>'car_id')::uuid then perform public.refresh_car_turnarounds(v_existing.car_id,v_week); end if;
  end if;
  perform public.assert_ride_request_day(v_id);
  perform public.assert_ride_seats_fit(v_id);
  perform public.assert_car_chain((p_ride->>'car_id')::uuid,v_week);
  if v_existing.car_id is not null and v_existing.car_id<>(p_ride->>'car_id')::uuid then perform public.assert_car_chain(v_existing.car_id,v_week); end if;
  return v_id;
end $$;
