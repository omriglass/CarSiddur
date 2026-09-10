-- Contested waiting-list groups, part 8: wire the "no free car" outcome to the groups.
--
-- try_auto_approve() is the one choke point every placement attempt goes through
-- (submit_request() for published/live weeks, enter_waiting_list(), settle_waitlist_cluster()),
-- so its no-car branch is where a newly waitlisted round-trip request on an already
-- published day gets folded into a contested group. Reproduced verbatim from
-- 20260907093200_quick_request_preferred_car.sql (the live definition — 091500/092800 are
-- older) with that one addition.
--
-- No recursion: join_waitlist_group() never calls try_auto_approve(). During
-- form_waitlist_groups() the call is harmless — inside a multi-request cluster it happens
-- in a subtransaction that is rolled back wholesale, and a singleton cluster by
-- construction overlaps no other candidate, so the only group it could join is one that
-- does not exist.
--
-- REQ §5.3, §7.3, §8; DATA_MODEL.md §3.6, §3.10.

create or replace function public.try_auto_approve(p_request_id uuid) returns jsonb
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_req record;
  v_car record;
  v_home uuid;
  v_turnaround interval;
  v_ride_id uuid;
  v_preferred_ok boolean := false;
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
    return jsonb_build_object('status', 'waitlisted', 'reason', 'NO_HOME_LOCATION');
  end if;

  select make_interval(mins => s.turnaround_minutes) into v_turnaround
  from public.department_settings s where s.department_id = v_req.department_id;

  -- Preferred car first: same eligibility rules as the fallback query below (shared,
  -- active, seats fit, at home at the requested depart time, no overlap incl. the
  -- turnaround buffer), scoped to that single car.
  if v_req.preferred_car_id is not null then
    select c.* into v_car
    from public.cars c
    join public.car_seat_configs csc on csc.car_id = c.id
    where c.id = v_req.preferred_car_id and c.department_id = v_req.department_id
      and c.status = 'active' and c.type = 'shared'
      and csc.adults >= v_req.adults and csc.child_seats >= v_req.child_seats and csc.boosters >= v_req.boosters
      and public.car_location_at(c.id, v_req.depart_at) = v_home
      and not exists (
        select 1 from public.rides r
        where r.car_id = c.id and r.status <> 'cancelled'
          and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(v_req.depart_at, v_req.return_at + v_turnaround, '[)')
      )
    order by c.id limit 1;
    v_preferred_ok := v_car.id is not null;
  end if;

  if not v_preferred_ok then
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
  end if;

  if v_car.id is null then
    perform set_config('app.audit_reason', 'try_auto_approve:no_car', true);
    update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_NO_CAR' where id = p_request_id;
    perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_req.department_id, v_req.week_start,
      jsonb_build_object('requestId', p_request_id::text), jsonb_build_object('request_id', p_request_id),
      format('waitlisted_request:%s', p_request_id))
    from public.sadranim_of(v_req.department_id, v_req.week_start) as s(profile_id);
    perform set_config('app.system_status_transition', 'off', true);
    -- 20260910091900 (contested waiting-list groups, REQ §7.3): if the day is already
    -- published, this member is not simply "waiting" — somebody else is holding the car in
    -- that window. join_waitlist_group() either adds them to the open group for that window
    -- or pairs them with another lone waitlisted round trip, so both sides get told and can
    -- settle it between them. It is a no-op for unpublished days, one-way requests and
    -- requests already in an open group, and it never calls back into this function.
    if public.join_waitlist_group(p_request_id) is not null then
      return jsonb_build_object('status', 'waitlisted', 'reason', 'WAITLISTED_CONTESTED');
    end if;
    -- NO_FREE_CAR (product owner's wording) and the pre-existing WAITLISTED_NO_CAR are the
    -- same case; kept as the one status_reason code (backward compatible with
    -- src/i18n/he.ts's statusReason table and every existing e2e/seed fixture using it).
    return jsonb_build_object('status', 'waitlisted', 'reason', 'WAITLISTED_NO_CAR');
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

  return jsonb_build_object('status', 'assigned', 'ride_id', v_ride_id, 'car_id', v_car.id);
end;
$$;

revoke execute on function public.try_auto_approve(uuid) from public, anon;
grant execute on function public.try_auto_approve(uuid) to authenticated;
