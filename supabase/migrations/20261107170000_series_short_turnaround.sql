-- REQ §13.190 (TODO TG2, owner 2026-11-07): the short-turnaround question for multi-day ("series") requests too.
-- Only the last day's end can cut into the car's next ride: place_series waives the turnaround after it under
-- `app.short_turnaround` = 'allow' (the gap stored on the last day's ride, the next ride's person told);
-- try_auto_approve_series under 'offer' names the next ride (submit_series_request `short_turnaround_ask`);
-- answer_short_turnaround settles a series as a whole. move_series stays Sadran-only and strict.

create or replace function public.place_series("p_series_id" "uuid", "p_car_id" "uuid", "p_pin" boolean DEFAULT false, "p_pin_reason" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_dept uuid; v_origin uuid; v_dest uuid; v_first timestamptz; v_last timestamptz;
  v_first_week date; v_turnaround interval; v_legs int; v_expected int; v_actor uuid := (select auth.uid());
  v_ride_ids uuid[] := '{}'; v_weeks date[] := '{}';
  leg record; v_ride_id uuid; v_origin_leg uuid; v_destination uuid; v_pin boolean; v_reason text;
  w date; v_after interval; v_gap smallint; v_last_ride uuid;
begin
  begin
    select q.department_id, min(q.depart_at), max(q.return_at), count(*)::int, max(q.series_count)::int
      into v_dept, v_first, v_last, v_legs, v_expected
    from public.requests q
    where q.series_id = p_series_id and q.status not in ('withdrawn','cancelled','denied','external')
    group by q.department_id;
    if v_dept is null or v_legs is distinct from v_expected then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'series_incomplete';
    end if;

    select min(q.week_start) into v_first_week from public.requests q where q.series_id = p_series_id;
    select q.origin_id into v_origin from public.requests q
    where q.series_id = p_series_id order by q.series_index limit 1;
    if v_origin is null then raise exception 'no_home_location' using errcode = 'P0412'; end if;
    select coalesce(q.destination_id, v_origin) into v_dest
    from public.requests q where q.series_id = p_series_id order by q.series_index limit 1;

    if not exists (select 1 from public.cars c
      where c.id = p_car_id and c.department_id = v_dept and c.status = 'active' and c.type = 'shared') then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'car_not_shared_active';
    end if;
    if exists (select 1 from public.requests q where q.series_id = p_series_id
      and not public.car_fits(p_car_id, q.adults, q.child_seats, q.boosters)) then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'seat_config_violation';
    end if;
    -- Every leg on the SAME car: a leg already parked on a different car blocks the move.
    if exists (select 1 from public.rides r
      where r.series_id = p_series_id and r.status <> 'cancelled' and r.car_id <> p_car_id) then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'series_split_across_cars';
    end if;

    -- A series can span weeks; the span check uses the largest turnaround any of its weeks requires.
    select make_interval(mins => coalesce(max(public.required_turnaround_minutes(v_dept, wk.week_start)), 30)) into v_turnaround
    from (select distinct q.week_start from public.requests q
          where q.series_id = p_series_id and q.status not in ('withdrawn','cancelled','denied','external')) wk;

    -- REQ §13.190 (TG2): after "תיאמתם עם X…?" (`app.short_turnaround` = 'allow') the car's next ride may start less
    -- than the turnaround after the last day ends; the turnaround after the ride before stays.
    v_after := case when coalesce(current_setting('app.short_turnaround', true), '') = 'allow' then interval '0' else v_turnaround end;
    -- Nobody else uses the car anywhere inside the span.
    if exists (select 1 from public.rides r
      where r.car_id = p_car_id and r.status <> 'cancelled' and not r.draft_hold and not r.planning_conflict
        and r.series_id is distinct from p_series_id
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_first, v_last + v_after, '[)')) then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'car_busy';
    end if;
    if exists (select 1 from public.car_maintenance_blocks b where b.car_id = p_car_id
      and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_first, v_last + v_turnaround, '[)')) then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'ride_conflicts_with_maintenance';
    end if;
    -- The car must be at the series' own origin when the series starts (own legs ignored so
    -- re-runs are idempotent).
    if coalesce((select r.destination_id from public.rides r
      where r.car_id = p_car_id and r.status <> 'cancelled' and not r.draft_hold and not r.planning_conflict
        and r.series_id is distinct from p_series_id and r.starts_at < v_first
        and not public.ride_is_reservation(r.id)
      order by r.starts_at desc limit 1), v_origin) <> v_origin then
      raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = 'car_not_home';
    end if;

    perform set_config('app.audit_reason', 'place_series', true);
    for leg in select q.* from public.requests q where q.series_id = p_series_id order by q.series_index loop
      v_weeks := v_weeks || leg.week_start;
      if exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                 where rr.request_id = leg.id and r.status <> 'cancelled') then
        continue;                                   -- already placed on p_car_id (checked above)
      end if;
      v_origin_leg  := case when leg.series_index = 1 then v_origin else v_dest end;
      v_destination := case when leg.series_index = leg.series_count then v_origin else v_dest end;
      v_pin    := p_pin or leg.week_start <> v_first_week;
      v_reason := case when leg.week_start <> v_first_week then 'SERIES_CARRY_OVER'
                       else coalesce(p_pin_reason, 'SERIES_PLACED') end;
      v_gap := case when v_after = interval '0' and leg.series_index = leg.series_count
                    then (public._short_turnaround_info(p_car_id, leg.return_at, null) ->> 'gap')::smallint end;
      insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
        driver_id, status, is_pinned, pin_reason, created_by, series_id, turnaround_override_minutes)
      values (v_dept, leg.week_start, p_car_id, leg.depart_at, leg.return_at, v_origin_leg, v_destination,
        leg.requester_id,
        case when public.is_week_public(v_dept, leg.week_start) then 'confirmed'::public.ride_status
             else 'draft'::public.ride_status end,
        v_pin, case when v_pin then v_reason else null end, coalesce(v_actor, leg.requester_id), p_series_id, v_gap)
      returning id into v_ride_id;
      if v_gap is not null then v_last_ride := v_ride_id; end if;
      insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
      values (v_ride_id, leg.id, 'driver', 'both', 'keep');
      perform public.assert_ride_seats_fit(v_ride_id);
      v_ride_ids := array_append(v_ride_ids, v_ride_id);
    end loop;

    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'assigned', status_reason = 'SERIES_PLACED' where series_id = p_series_id;
    perform set_config('app.system_status_transition', 'off', true);

    for w in select distinct x from unnest(v_weeks) x order by 1 loop
      perform public.assert_car_chain(p_car_id, w);
    end loop;
    if v_last_ride is not null then
      perform public._notify_short_turnaround(p_car_id, v_last, v_last_ride,
        coalesce(v_actor, (select q.requester_id from public.requests q where q.series_id = p_series_id order by q.series_index limit 1)));
    end if;
  exception when others then
    if sqlstate = 'MDR03' then raise; end if;
    raise exception 'series_car_unavailable' using errcode = 'MDR03', detail = sqlerrm;
  end;

  return jsonb_build_object('series_id', p_series_id, 'car_id', p_car_id,
    'ride_ids', coalesce(to_jsonb(v_ride_ids), '[]'::jsonb),
    'weeks', coalesce(to_jsonb((select array_agg(distinct x order by x) from unnest(v_weeks) x)), '[]'::jsonb));
end $$;

create or replace function public.try_auto_approve_series("p_series_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_head record; v_car record; v_result jsonb; v_last timestamptz; v_short jsonb; v_prev text;
begin
  select q.id, q.department_id, q.week_start, q.requester_id, q.preferred_car_id
    into v_head from public.requests q where q.series_id = p_series_id order by q.series_index limit 1;
  if v_head.id is null then return null; end if;
  -- REQ §13.94: a drop_off series is never held on one car; the Sadran serves each leg.
  if exists (select 1 from public.requests q where q.series_id = p_series_id and q.trip_type = 'drop_off') then
    return null;
  end if;

  for v_car in
    select c.id from public.cars c
    where c.department_id = v_head.department_id and c.status = 'active' and c.type = 'shared'
    order by (c.id = v_head.preferred_car_id) desc, c.id
  loop
    begin
      v_result := public.place_series(p_series_id, v_car.id, true, 'SERIES_PLACED');
      return v_result || jsonb_build_object('status', 'assigned', 'reason', 'SERIES_PLACED');
    exception when others then
      null;                                        -- try the next car; the subtransaction unwinds
    end;
  end loop;

  -- REQ §13.190 (TG2): with `app.short_turnaround` = 'offer', a series that only the turnaround before the car's next
  -- ride keeps out waits silently and the result names that ride (answer_short_turnaround settles it); when that ride
  -- is the requester's own there is nobody to ask and the series is placed.
  select max(q.return_at) into v_last from public.requests q
  where q.series_id = p_series_id and q.status not in ('withdrawn','cancelled','denied','external');
  if coalesce(current_setting('app.short_turnaround', true), '') = 'offer'
     and public.is_day_public(v_head.department_id, v_head.week_start, (v_last at time zone 'Asia/Jerusalem')::date) then
    v_prev := current_setting('app.short_turnaround', true);
    for v_car in
      select c.id from public.cars c
      where c.department_id = v_head.department_id and c.status = 'active' and c.type = 'shared'
      order by (c.id = v_head.preferred_car_id) desc, c.id
    loop
      v_short := public._short_turnaround_info(v_car.id, v_last, null);
      continue when v_short is null;
      begin
        perform set_config('app.short_turnaround', 'allow', true);
        v_result := public.place_series(p_series_id, v_car.id, true, 'SERIES_PLACED');
        perform set_config('app.short_turnaround', v_prev, true);
        if (v_short ->> 'recipient_id')::uuid is not distinct from v_head.requester_id then
          return v_result || jsonb_build_object('status', 'assigned', 'reason', 'SERIES_PLACED');
        end if;
        raise exception 'short_turnaround_probe' using errcode = 'PXST1';   -- ask first: undo the placement
      exception when others then
        perform set_config('app.short_turnaround', v_prev, true);
        if sqlstate = 'PXST1' then
          perform set_config('app.system_status_transition', 'on', true);
          perform set_config('app.audit_reason', 'try_auto_approve_series:short_turnaround', true);
          update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_SERIES_NO_CAR'
          where series_id = p_series_id;
          perform set_config('app.system_status_transition', 'off', true);
          return jsonb_build_object('status', 'waitlisted', 'reason', 'WAITLISTED_SERIES_NO_CAR', 'series_id', p_series_id,
            'short_turnaround', v_short - 'recipient_id');
        end if;
      end;
    end loop;
  end if;

  perform set_config('app.system_status_transition', 'on', true);
  perform set_config('app.audit_reason', 'try_auto_approve_series:no_car', true);
  update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_SERIES_NO_CAR'
  where series_id = p_series_id;
  perform set_config('app.system_status_transition', 'off', true);

  perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_head.department_id, v_head.week_start,
    jsonb_build_object('requestId', v_head.id::text),
    jsonb_build_object('request_id', v_head.id, 'series_id', p_series_id),
    format('waitlisted_series:%s:%s', p_series_id, s.profile_id))
  from public.sadranim_of(v_head.department_id, v_head.week_start) as s(profile_id);

  return jsonb_build_object('status', 'waitlisted', 'reason', 'WAITLISTED_SERIES_NO_CAR', 'series_id', p_series_id);
end $$;

create or replace function public.answer_short_turnaround("p_request_id" "uuid", "p_accept" boolean) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare q public.requests%rowtype; v_result jsonb;
begin
  select * into q from public.requests where id = p_request_id;
  if not found then raise exception 'not_authorized'; end if;
  if not public.is_approved() or not public.is_week_public(q.department_id, q.week_start)
     or not (q.requester_id = (select auth.uid()) or public.request_related(q.id, (select auth.uid()))
             or public.can_manage_week(q.department_id, q.week_start)) then
    raise exception 'not_authorized';
  end if;
  if q.status <> 'waitlisted' then return jsonb_build_object('status', q.status, 'unchanged', true); end if;
  perform set_config('app.short_turnaround', case when p_accept then 'allow' else 'off' end, true);
  -- REQ §13.190 (TG2): a multi-day request is placed (or waitlisted) as a whole.
  v_result := case when q.series_id is not null then public.try_auto_approve_series(q.series_id)
                   else public.try_auto_approve(p_request_id) end;
  perform set_config('app.short_turnaround', 'off', true);
  return coalesce(v_result, jsonb_build_object('status', q.status));
end $$;

create or replace function public.submit_series_request("payload" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_dept uuid := (payload ->> 'department_id')::uuid;
  v_depart timestamptz := nullif(payload ->> 'depart_at', '')::timestamptz;
  v_return timestamptz := nullif(payload ->> 'return_at', '')::timestamptz;
  v_shape public.trip_shape := coalesce((payload ->> 'trip_shape')::public.trip_shape, 'round_trip');
  v_first_date date; v_last_date date; v_count int; v_series uuid := gen_random_uuid();
  v_d date; v_week date; v_first_week date; v_phase public.week_phase;
  v_ids uuid[] := '{}'; v_warnings jsonb := '[]'::jsonb; v_leg jsonb; v_auto jsonb;
  v_prefer uuid;
begin
  -- REQ §13.142: an edit of an existing series replaces it (`_edit_series_request` calls back without series_id).
  if payload ? 'series_id' then
    return public._edit_series_request(payload);
  end if;
  if payload ? 'request_id' then
    raise exception 'series_edit_not_supported' using errcode = 'MDR02';
  end if;
  if v_dept is null or v_depart is null or v_return is null or v_shape <> 'round_trip' then
    raise exception 'invalid_series_request' using errcode = 'P0001';
  end if;
  v_first_date := (v_depart at time zone 'Asia/Jerusalem')::date;
  v_last_date  := (v_return at time zone 'Asia/Jerusalem')::date;
  if v_last_date <= v_first_date then
    raise exception 'invalid_series_request' using errcode = 'P0001';
  end if;
  v_count := (v_last_date - v_first_date) + 1;
  v_first_week := v_first_date - extract(dow from v_first_date)::int;

  -- Pre-flight every day, so a span that runs past the sane ceiling fails before any leg is
  -- filed (the raise would unwind them anyway; this just keeps the error unambiguous). A
  -- week that has no row yet is materialized `upcoming` right here, not left for
  -- submit_request() to reject.
  for i in 0 .. v_count - 1 loop
    v_d := v_first_date + i;
    v_week := v_d - extract(dow from v_d)::int;
    if v_week < public.current_week_start() or v_week > v_first_week + 42 then
      raise exception 'series_week_not_open' using errcode = 'MDR01';
    end if;
    if not exists (select 1 from public.weeks w where w.department_id = v_dept and w.week_start = v_week) then
      perform public.ensure_upcoming_week(v_dept, v_week);
    end if;
  end loop;

  for i in 0 .. v_count - 1 loop
    v_d := v_first_date + i;
    v_week := v_d - extract(dow from v_d)::int;
    v_leg := public.submit_request(
      (payload - 'request_id' - 'expected_version' - 'trip_type') || jsonb_build_object(
        'week_start', v_week,
        'trip_shape', 'round_trip',
        'depart_at', case when i = 0 then v_depart else (v_d::timestamp) at time zone 'Asia/Jerusalem' end,
        'return_at', case when i = v_count - 1 then v_return
                          else ((v_d + time '23:59')) at time zone 'Asia/Jerusalem' end,
        'series_id', v_series, 'series_index', i + 1, 'series_count', v_count));
    v_ids := array_append(v_ids, (v_leg ->> 'request_id')::uuid);
    if i = 0 then v_warnings := coalesce(v_leg -> 'warnings', '[]'::jsonb); end if;
  end loop;

  select w.phase into v_phase from public.weeks w where w.department_id = v_dept and w.week_start = v_first_week;
  if v_phase in ('published', 'live') then
    -- REQ §13.142: an edited series keeps the car it had when that car is still free for the whole span.
    v_prefer := nullif(current_setting('app.series_prefer_car', true), '')::uuid;
    if v_prefer is not null then
      begin
        v_auto := public.place_series(v_series, v_prefer, true, 'SERIES_PLACED')
          || jsonb_build_object('status', 'assigned', 'reason', 'SERIES_PLACED');
      exception when others then
        v_auto := null;                              -- the old car is busy now: any free car below
      end;
    end if;
    if v_auto is null then
      -- REQ §13.190 (TG2): a new series from the form may be named the car's next ride instead of waitlisted.
      if v_prefer is null and coalesce((payload ->> 'short_turnaround_ask')::boolean, false) then
        perform set_config('app.short_turnaround', 'offer', true);
      end if;
      v_auto := public.try_auto_approve_series(v_series);
      perform set_config('app.short_turnaround', 'off', true);
    end if;
  elsif nullif(current_setting('app.series_prefer_car', true), '') is not null then
    -- R13B5: before publishing, an edited series keeps the Sadran's draft car when it is still free for the
    -- whole span (as the solver places a series: not pinned); else it waits for the next solve like any request.
    begin
      perform public.place_series(v_series, nullif(current_setting('app.series_prefer_car', true), '')::uuid, false, null);
    exception when others then
      null;
    end;
  end if;

  return jsonb_build_object('series_id', v_series, 'request_ids', to_jsonb(v_ids), 'warnings', v_warnings)
    || coalesce(v_auto, '{}'::jsonb);
end $$;
