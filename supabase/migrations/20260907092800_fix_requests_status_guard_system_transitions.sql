-- Stage 3 hardening fix (bug found while writing e2e/auto-approve.spec.ts, DATA_MODEL.md
-- §6.1 item 20): REQUIREMENTS §8's "new request on a free car" / "new request with no free
-- car" live-changes rows (`try_auto_approve()`, called from `submit_request()` in `live`
-- weeks) were completely broken for every brand-new submission — reproduced directly against
-- the local stack, independent of any client code:
--
--   ERROR:  invalid_request_status_transition
--   DETAIL:  member cannot move request <id> from submitted to assigned
--   CONTEXT:  PL/pgSQL function requests_status_guard() line 12 at RAISE
--
-- `requests_status_guard()` (`20260907090700_requests.sql`, invariant #10, "last line of
-- defence behind the RPCs") blocks a member from moving their *own* request to any status
-- but withdrawn/cancelled unless they can_manage_week() (a Sadran/Admin). That is correct for
-- a member trying to write `requests.status` some other way, but `try_auto_approve()` and
-- `submit_request()`'s live-phase one-way branch are themselves the trusted system logic
-- deciding the outcome of the *requester's own* submission — `auth.uid()` is unavoidably the
-- requester in both cases, so every one of them tripped this guard: not just the "found a
-- free car → assigned" branch reproduced above, but equally "no free car → waitlisted" and
-- the one-way "always waitlisted" branch (same `old.status = 'submitted'`, same actor). No
-- previous migration or e2e spec exercised "member submits a fresh request during a live
-- week" end to end, so this was never caught.
--
-- Fix: the same `app.in_publish`-style trusted-call idiom already used by
-- `weeks_guard_published_version()` — a narrowly-scoped session flag, set only around the
-- specific UPDATE statements that need it, checked by the guard.

create or replace function public.requests_status_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.status = old.status then
    return new;
  end if;
  if coalesce(current_setting('app.system_status_transition', true), 'off') = 'on' then
    return new;
  end if;
  if old.status in ('withdrawn','cancelled') then
    raise exception 'invalid_request_status_transition' using errcode = 'P0001',
      detail = format('request %s status %s is terminal', old.id, old.status);
  end if;
  if (select auth.uid()) = old.requester_id and not public.can_manage_week(old.department_id, old.week_start) then
    if new.status not in ('withdrawn','cancelled') then
      raise exception 'invalid_request_status_transition' using errcode = 'P0001',
        detail = format('member cannot move request %s from %s to %s', old.id, old.status, new.status);
    end if;
  end if;
  return new;
end;
$$;

-- try_auto_approve: full body reproduced verbatim from 20260907091500_rpc.sql, plus the
-- trusted-transition flag set once at the top (covers both its own status-changing UPDATEs —
-- the "no car" waitlist branch and the "assigned" branch — and cleared again before return so
-- it never leaks into whatever the caller does next in the same transaction).
create or replace function public.try_auto_approve(p_request_id uuid) returns public.request_status
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_req record;
  v_car record;
  v_home uuid;
  v_turnaround interval;
  v_ride_id uuid;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req.trip_shape <> 'round_trip' then
    return null;
  end if;

  perform set_config('app.system_status_transition', 'on', true);

  select d.home_destination_id into v_home from public.departments d where d.id = v_req.department_id;
  if v_home is null then
    update public.requests set status = 'waitlisted', status_reason = 'NO_HOME_LOCATION' where id = p_request_id;
    perform set_config('app.system_status_transition', 'off', true);
    return 'waitlisted';
  end if;

  select make_interval(mins => s.turnaround_minutes) into v_turnaround
  from public.department_settings s where s.department_id = v_req.department_id;

  select c.* into v_car
  from public.cars c
  join public.car_seat_configs csc on csc.car_id = c.id
  where c.department_id = v_req.department_id and c.status = 'active' and c.type = 'shared'
    and csc.adults >= v_req.adults and csc.child_seats >= v_req.child_seats and csc.boosters >= v_req.boosters
    and public.car_location_at(c.id, v_req.depart_at) = v_home
    and not exists (
      select 1 from public.rides r
      where r.car_id = c.id and r.status <> 'cancelled'
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_req.depart_at, v_req.return_at + v_turnaround, '[)')
    )
  order by c.id limit 1;

  if v_car.id is null then
    perform set_config('app.audit_reason', 'try_auto_approve:no_car', true);
    update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_NO_CAR' where id = p_request_id;
    perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_req.department_id, v_req.week_start,
      jsonb_build_object('requestId', p_request_id::text), jsonb_build_object('request_id', p_request_id),
      format('waitlisted_request:%s', p_request_id))
    from public.sadranim_of(v_req.department_id, v_req.week_start) as s(profile_id);
    perform set_config('app.system_status_transition', 'off', true);
    return 'waitlisted';
  end if;

  perform set_config('app.audit_reason', 'try_auto_approve:assigned', true);
  insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
    driver_id, status, is_pinned, pin_reason, created_by)
  values (v_req.department_id, v_req.week_start, v_car.id, v_req.depart_at, v_req.return_at, v_home, v_home,
    v_req.requester_id, 'confirmed', true, 'AUTO_APPROVED', v_req.requester_id)
  returning id into v_ride_id;

  insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
  values (v_ride_id, p_request_id, 'driver', 'both', 'keep');

  perform public.assert_car_chain(v_car.id, v_req.week_start);

  update public.requests set status = 'assigned', status_reason = 'AUTO_APPROVED_FREE_CAR' where id = p_request_id;
  perform set_config('app.system_status_transition', 'off', true);

  perform public.enqueue_notification(v_req.requester_id, 'auto_approved', v_req.department_id, v_req.week_start,
    jsonb_build_object('requestId', p_request_id::text), jsonb_build_object('request_id', p_request_id, 'ride_id', v_ride_id),
    format('auto_approved:%s', p_request_id));
  perform public.enqueue_notification(s.profile_id, 'auto_approved', v_req.department_id, v_req.week_start,
    jsonb_build_object('requestId', p_request_id::text), jsonb_build_object('request_id', p_request_id, 'ride_id', v_ride_id),
    format('auto_approved:%s:%s', p_request_id, s.profile_id))
  from public.sadranim_of(v_req.department_id, v_req.week_start) as s(profile_id);

  return 'assigned';
end;
$$;

-- submit_request: only the live-phase one-way branch's status-changing UPDATE is new here
-- (same trusted-transition need — the requester is their own `old.requester_id`); full body
-- otherwise reproduced verbatim from 20260907091500_rpc.sql.
create or replace function public.submit_request(payload jsonb) returns jsonb
security definer set search_path = public, pg_temp
language plpgsql as $$
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
  v_week record;
  v_existing record;
  v_can_manage boolean;
  v_is_late boolean;
  v_status public.request_status;
  v_warnings jsonb := '[]'::jsonb;
  v_join_ride_id uuid := nullif(payload ->> 'join_ride_id', '')::uuid;
  v_join_car_type public.car_type;
  v_join_owner uuid;
begin
  if v_requester_id <> v_actor then
    if not public.can_manage_week(v_department_id, v_week_start) then
      raise exception 'not_authorized' using errcode = 'P0001';
    end if;
    v_can_manage := true;
  else
    v_can_manage := public.can_manage_week(v_department_id, v_week_start);
  end if;

  select * into v_week from public.weeks where department_id = v_department_id and week_start = v_week_start;
  if v_week is null then
    raise exception 'week_not_open' using errcode = 'P0001';
  end if;

  if v_trip_shape <> 'round_trip' then
    v_needs_car := true;
    if v_one_way_mode is null then
      raise exception 'one_way_car_mode_required' using errcode = 'P0001';
    end if;
  end if;

  if v_request_id is not null then
    select * into v_existing from public.requests where id = v_request_id;
    if v_existing is null then
      raise exception 'request_not_found' using errcode = 'P0001';
    end if;
    if v_existing.requester_id <> v_actor and not public.can_manage_week(v_existing.department_id, v_existing.week_start) then
      raise exception 'not_authorized' using errcode = 'P0001';
    end if;
    if payload ? 'expected_version' and v_existing.version <> (payload ->> 'expected_version')::int then
      perform public.raise_stale_version();
    end if;
  end if;

  v_is_late := now() > v_week.close_at;

  perform set_config('app.audit_reason', 'submit_request', true);

  if v_request_id is null then
    v_status := 'submitted';
    insert into public.requests (
      department_id, week_start, requester_id, filed_by, destination_id, destination_text, ride_type_id,
      trip_shape, depart_at, return_at, one_way_car_mode, needs_car_at_destination,
      adults, child_seats, boosters, has_luggage,
      flex_depart_early, flex_depart_late, flex_return_early, flex_return_late,
      notes, is_late, submitted_at, status, freed_slot_opt_out, join_ride_id, template_id
    ) values (
      v_department_id, v_week_start, v_requester_id, v_actor,
      nullif(payload ->> 'destination_id', '')::uuid, nullif(payload ->> 'destination_text', ''),
      (payload ->> 'ride_type_id')::uuid,
      v_trip_shape, v_depart_at, v_return_at, v_one_way_mode, v_needs_car,
      coalesce((payload ->> 'adults')::smallint, 1), coalesce((payload ->> 'child_seats')::smallint, 0),
      coalesce((payload ->> 'boosters')::smallint, 0), coalesce((payload ->> 'has_luggage')::boolean, false),
      coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_return_early', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_return_late', '')::interval, '0'),
      nullif(payload ->> 'notes', ''), v_is_late, now(), v_status,
      coalesce((payload ->> 'freed_slot_opt_out')::boolean, false),
      v_join_ride_id, nullif(payload ->> 'template_id', '')::uuid
    ) returning id into v_request_id;
  else
    update public.requests set
      destination_id = nullif(payload ->> 'destination_id', '')::uuid,
      destination_text = nullif(payload ->> 'destination_text', ''),
      ride_type_id = (payload ->> 'ride_type_id')::uuid,
      trip_shape = v_trip_shape, depart_at = v_depart_at, return_at = v_return_at,
      one_way_car_mode = v_one_way_mode, needs_car_at_destination = v_needs_car,
      adults = coalesce((payload ->> 'adults')::smallint, adults),
      child_seats = coalesce((payload ->> 'child_seats')::smallint, child_seats),
      boosters = coalesce((payload ->> 'boosters')::smallint, boosters),
      has_luggage = coalesce((payload ->> 'has_luggage')::boolean, has_luggage),
      flex_depart_early = coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, flex_depart_early),
      flex_depart_late = coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, flex_depart_late),
      flex_return_early = coalesce(nullif(payload ->> 'flex_return_early', '')::interval, flex_return_early),
      flex_return_late = coalesce(nullif(payload ->> 'flex_return_late', '')::interval, flex_return_late),
      notes = coalesce(nullif(payload ->> 'notes', ''), notes),
      is_late = v_is_late,
      freed_slot_opt_out = coalesce((payload ->> 'freed_slot_opt_out')::boolean, freed_slot_opt_out),
      join_ride_id = coalesce(v_join_ride_id, join_ride_id),
      changed_since_solve = (v_week.phase <> 'open')
    where id = v_request_id
    returning status into v_status;

    if v_week.phase in ('solving','published') then
      perform public.enqueue_notification(s.profile_id, 'request_changed', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
        format('request_changed:%s:%s', v_request_id, now()))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id);
    end if;
  end if;

  -- Duplicate detection (warn, never block, REQ §5.3).
  if exists (
    select 1 from public.requests q
    where q.requester_id = v_requester_id and q.id <> v_request_id and q.status not in ('withdrawn','cancelled','denied')
      and q.department_id = v_department_id
      and public.request_span(q.depart_at, q.return_at) && public.request_span(v_depart_at, v_return_at)
  ) then
    v_warnings := v_warnings || '"DUPLICATE_OVERLAP"'::jsonb;
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

  if v_week.phase = 'live' and v_trip_shape = 'round_trip' then
    perform public.try_auto_approve(v_request_id);
  elsif v_week.phase = 'live' then
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_ONE_WAY' where id = v_request_id;
    perform set_config('app.system_status_transition', 'off', true);
    perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
      jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
      format('waitlisted_request:%s', v_request_id))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id);
  end if;

  if v_is_late then
    perform public.enqueue_notification(s.profile_id, 'late_request', v_department_id, v_week_start,
      jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
      format('late_request:%s', v_request_id))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id);
  end if;

  return jsonb_build_object('request_id', v_request_id, 'is_late', v_is_late, 'warnings', v_warnings);
end;
$$;
