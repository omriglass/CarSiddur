-- REQ §13.176 (owner 2026-11-01): choosing, volunteering or taking over as a driver while busy elsewhere asks instead of
-- refusing (`person_busy`, then the same call with p_allow_busy), and "busy" is only the person's own part of the other
-- ride (`person_ride_span`): a guest picked up on the way back is free in the morning (Agata's case).

drop function if exists public.claim_ride_driver(uuid, integer);
create or replace function public.claim_ride_driver(p_ride_id uuid, p_expected_version integer, p_allow_busy boolean DEFAULT false) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare r public.rides%rowtype; passenger record; v_car text; v_driver_name text; v_route text; v_day text;
begin
  select * into r from public.rides where id=p_ride_id for update;
  if not found then raise exception 'ride_not_found'; end if;
  if not public.member_of(r.department_id) or (not public.is_week_public(r.department_id,r.week_start) and not public.can_manage_week(r.department_id,r.week_start)) then raise exception 'not_authorized'; end if;
  if p_expected_version is null or r.version<>p_expected_version then perform public.raise_stale_version(); end if;
  -- REQ §13.170 (QA R17B1): someone being driven on this ride (a הקפצה / pickup leg) cannot drive it themselves.
  if exists(select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id
            where rr.ride_id=r.id and rr.car_mode='chauffeur'
              and (q.requester_id=(select auth.uid())
                   or exists(select 1 from public.request_companions c where c.request_id=q.id and c.profile_id=(select auth.uid())))) then
    raise exception 'own_dropoff_driver';
  end if;
  if not r.needs_driver or r.status='cancelled' then raise exception 'ride_driver_already_assigned'; end if;
  if r.ends_at<=now() or exists(select 1 from public.weeks where department_id=r.department_id and week_start=r.week_start and phase='archived') then raise exception 'ride_in_past'; end if;
  if not exists(select 1 from public.cars where id=r.car_id and status='active') then raise exception 'car_unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ride-driver:'||(select auth.uid())::text,0));
  -- REQ §13.176: another ride of mine at that time (my own part of it) is a question, not a refusal.
  perform public._person_busy_mode(p_allow_busy);
  perform public._assert_person_free((select auth.uid()),tstzrange(r.starts_at,r.ends_at,'[)'),r.id);
  perform set_config('app.audit_reason','claim_ride_driver',true);
  update public.rides set driver_id=(select auth.uid()),needs_driver=false,
    status=case when status='flagged' and flag_reason='NEEDS_DRIVER' then 'confirmed'::public.ride_status else status end,
    flag_reason=case when flag_reason='NEEDS_DRIVER' then null else flag_reason end where id=r.id;
  perform public.assert_ride_driver(r.id);perform public.assert_ride_seats_fit(r.id);perform public.assert_car_chain(r.car_id,r.week_start);
  perform set_config('app.system_status_transition','on',true);
  update public.requests set status='merged',status_reason='DRIVER_CLAIMED' where id in(select request_id from public.ride_requests where ride_id=r.id);
  -- REQ §13.170 (R17U2): the riders hear that a driver was found and who it is (set_ride_driver's notice), not a bare
  -- "change in your siddur".
  select name into v_car from public.cars where id=r.car_id;
  select full_name into v_driver_name from public.profiles where id=(select auth.uid());
  v_route:=public.ride_notice_route(r.id); v_day:=public.day_date_label(r.starts_at);
  for passenger in
    select q.id,q.requester_id as pid from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=r.id
    union select null,rp.person_id from public.ride_passengers rp where rp.ride_id=r.id and rp.person_id is not null
  loop
    continue when passenger.pid=(select auth.uid());
    perform public.enqueue_notification(passenger.pid,'outcome_changed',r.department_id,r.week_start,
      jsonb_build_object('driverName',coalesce(v_driver_name,''),'route',v_route,'day',v_day,'car',coalesce(v_car,'')),
      jsonb_build_object('variant','driver_assigned_passenger','request_id',passenger.id,'ride_id',r.id),
      format('driver_claimed:%s:%s:%s',r.id,r.version,passenger.pid));
  end loop;
  perform set_config('app.system_status_transition','off',true);
end $$;

drop function if exists public.take_over_ride_driver(uuid, integer);
create or replace function public.take_over_ride_driver(p_ride_id uuid, p_expected_version integer, p_allow_busy boolean DEFAULT false) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare r public.rides%rowtype; v_actor uuid := (select auth.uid()); v_old uuid; v_name text; v_car text; v_route text; v_day text; p record;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found or r.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if not public.member_of(r.department_id) or (not public.is_week_public(r.department_id, r.week_start) and not public.can_manage_week(r.department_id, r.week_start)) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_expected_version is null or r.version <> p_expected_version then perform public.raise_stale_version(); end if;
  -- the volunteer stepped down in the meantime: taking over is claiming the empty seat
  if r.needs_driver then perform public.claim_ride_driver(r.id, r.version, p_allow_busy); return; end if;
  if exists (select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
             where rr.ride_id = r.id and rr.car_mode = 'chauffeur'
               and (q.requester_id = v_actor
                    or exists (select 1 from public.request_companions c where c.request_id = q.id and c.profile_id = v_actor))) then
    raise exception 'own_dropoff_driver' using errcode = 'P0001';
  end if;
  if r.driver_id is null or r.driver_id = v_actor
     or not exists (select 1 from public.ride_requests where ride_id = r.id)
     or exists (select 1 from public.ride_requests where ride_id = r.id and role = 'driver') then
    raise exception 'ride_driver_not_assignable' using errcode = 'P0001';
  end if;
  if r.starts_at <= now() or exists (select 1 from public.weeks where department_id = r.department_id and week_start = r.week_start and phase = 'archived') then
    raise exception 'ride_in_past' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.cars where id = r.car_id and status = 'active') then raise exception 'car_unavailable' using errcode = 'P0001'; end if;
  if exists (select 1 from public.profiles where id = v_actor and does_not_drive) then
    raise exception 'non_driver_cannot_drive' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ride-driver:' || v_actor::text, 0));
  -- REQ §13.176: another ride of mine at that time (my own part of it) is a question, not a refusal.
  perform public._person_busy_mode(p_allow_busy);
  perform public._assert_person_free(v_actor, tstzrange(r.starts_at, r.ends_at, '[)'), r.id);
  v_old := r.driver_id;
  perform set_config('app.audit_reason', 'take_over_ride_driver', true);
  update public.rides set driver_id = v_actor where id = r.id;
  perform public.assert_ride_driver(r.id);
  perform public.assert_ride_seats_fit(r.id);
  perform public.assert_car_chain(r.car_id, r.week_start);

  if not public.is_day_public(r.department_id, r.week_start, (r.starts_at at time zone 'Asia/Jerusalem')::date) then return; end if;
  select full_name into v_name from public.profiles where id = v_actor;
  select name into v_car from public.cars where id = r.car_id;
  v_route := public.ride_notice_route(r.id);
  v_day := public.day_date_label(r.starts_at);
  perform public.enqueue_notification(v_old, 'outcome_changed', r.department_id, r.week_start,
    jsonb_build_object('driverName', coalesce(v_name, ''), 'route', v_route, 'day', v_day, 'car', coalesce(v_car, '')),
    jsonb_build_object('variant', 'driver_taken_over', 'ride_id', r.id),
    format('driver_taken_over:%s:%s:%s', r.id, r.version, v_old));
  for p in
    select q.requester_id as pid from public.ride_requests rr join public.requests q on q.id = rr.request_id where rr.ride_id = r.id
    union select rp.person_id from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id is not null
  loop
    continue when p.pid = v_actor or p.pid = v_old;
    perform public.enqueue_notification(p.pid, 'outcome_changed', r.department_id, r.week_start,
      jsonb_build_object('driverName', coalesce(v_name, ''), 'route', v_route, 'day', v_day, 'car', coalesce(v_car, '')),
      jsonb_build_object('variant', 'driver_changed_passenger', 'ride_id', r.id),
      format('driver_assigned_passenger:%s:%s:%s', r.id, r.version, p.pid));
  end loop;
end $$;

drop function if exists public.set_ride_driver(uuid, uuid, integer);
create or replace function public.set_ride_driver(p_ride_id uuid, p_driver_id uuid, p_expected_version integer, p_allow_busy boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  r public.rides%rowtype; v_actor uuid := (select auth.uid()); v_by text; v_driver_name text; v_car text;
  v_route text; v_day text; v_depart text; v_ret text; p record; v_notified uuid[] := '{}';
  v_old_driver uuid; v_replace boolean := false; v_own_req uuid; v_own_n int; v_prev_sys text; v_was_comp boolean := false;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found or r.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(r.department_id, r.week_start) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_expected_version is null or r.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if exists (select 1 from public.weeks where department_id = r.department_id and week_start = r.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  if r.ends_at <= now() then raise exception 'ride_in_past' using errcode = 'P0001'; end if;
  if exists (select 1 from public.cars c where c.id = r.car_id and c.type = 'temporary') then
    raise exception 'private_car_owner_only' using errcode = 'P0001';
  end if;

  select full_name into v_by from public.profiles where id = v_actor;
  select name into v_car from public.cars where id = r.car_id;
  v_route := public.ride_notice_route(r.id);
  v_day := public.day_date_label(r.starts_at);
  v_depart := to_char(r.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI');
  v_ret := to_char(r.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI');
  perform set_config('app.audit_reason', 'set_ride_driver', true);

  if p_driver_id is null then
    -- back to needs-driver: only a volunteer driver (no request of their own on the ride) can be taken off
    if r.needs_driver or r.driver_id is null
       or not exists (select 1 from public.ride_requests where ride_id = r.id)
       or exists (select 1 from public.ride_requests where ride_id = r.id and role = 'driver') then
      raise exception 'ride_driver_not_assignable' using errcode = 'P0001';
    end if;
    update public.rides set driver_id = null, needs_driver = true, is_pinned = true, pin_reason = 'MISSING_DRIVER',
      status = case when status = 'draft' then 'draft'::public.ride_status else 'flagged'::public.ride_status end,
      flag_reason = 'NEEDS_DRIVER' where id = r.id;
    perform public.assert_ride_driver(r.id);
    -- nobody is told about a day that is not published yet
    if not public.is_day_public(r.department_id, r.week_start, (r.starts_at at time zone 'Asia/Jerusalem')::date) then
      return jsonb_build_object('ride_id', r.id, 'needs_driver', true);
    end if;
    for p in
      select q.requester_id as pid from public.ride_requests rr join public.requests q on q.id = rr.request_id where rr.ride_id = r.id
      union select rp.person_id from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id is not null
    loop
      continue when p.pid = v_actor;
      perform public.enqueue_notification(p.pid, 'outcome_changed', r.department_id, r.week_start,
        jsonb_build_object('byName', coalesce(v_by, ''), 'route', v_route, 'day', v_day, 'car', coalesce(v_car, '')),
        jsonb_build_object('variant', 'driver_unassigned', 'ride_id', r.id),
        format('driver_unassigned:%s:%s:%s', r.id, r.version, p.pid));
    end loop;
    return jsonb_build_object('ride_id', r.id, 'needs_driver', true);
  end if;

  if not r.needs_driver then
    -- R6B8/R6M1: a volunteer driver (no request of their own on the ride) is replaced in one step.
    -- Owner 2026-10-16: so is a driver who drives their own request; that request moves to the new driver.
    if r.driver_id is null or r.driver_id = p_driver_id
       or not exists (select 1 from public.ride_requests where ride_id = r.id) then
      raise exception 'ride_driver_not_assignable' using errcode = 'P0001';
    end if;
    select count(*), min(rr.request_id::text)::uuid into v_own_n, v_own_req
    from public.ride_requests rr where rr.ride_id = r.id and rr.role = 'driver';
    if v_own_n > 1 then raise exception 'ride_driver_not_assignable' using errcode = 'P0001'; end if;
    if v_own_n = 1 then
      if not exists (select 1 from public.requests q where q.id = v_own_req and q.requester_id = r.driver_id and q.series_id is null)
         or exists (select 1 from public.ride_requests rr2 join public.rides r2 on r2.id = rr2.ride_id
                    where rr2.request_id = v_own_req and rr2.ride_id <> r.id and r2.status <> 'cancelled') then
        raise exception 'ride_driver_not_assignable' using errcode = 'P0001';
      end if;
    else
      v_own_req := null;
    end if;
    v_replace := true; v_old_driver := r.driver_id;
  end if;
  if not exists (
    select 1 from public.profiles pr join public.department_members dm on dm.profile_id = pr.id
    where pr.id = p_driver_id and pr.approval_status = 'approved' and dm.department_id = r.department_id and dm.removed_at is null
  ) then raise exception 'driver_not_member' using errcode = 'P0001'; end if;
  if exists (select 1 from public.profiles where id = p_driver_id and does_not_drive) then
    raise exception 'non_driver_cannot_drive' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ride-driver:' || p_driver_id::text, 0));
  -- REQ §13.176 (owner 2026-11-01): the new driver driving, or riding, elsewhere at that time - only their own part of
  -- that ride counts - is a question for the Sadran ("person_busy", retried with p_allow_busy), never a refusal.
  perform public._person_busy_mode(p_allow_busy);
  perform public._assert_person_free(p_driver_id, tstzrange(r.starts_at, r.ends_at, '[)'), r.id);

  perform set_config('app.audit_reason', case when v_replace then 'replace_ride_driver' else 'set_ride_driver' end, true);
  update public.rides set driver_id = p_driver_id, needs_driver = false,
    status = case when status = 'flagged' and flag_reason = 'NEEDS_DRIVER' then 'confirmed'::public.ride_status else status end,
    flag_reason = case when flag_reason = 'NEEDS_DRIVER' then null else flag_reason end
  where id = r.id;
  if v_own_req is not null then
    -- the driver's own request moves to the new driver; the old filer stays recorded as filed_by
    delete from public.request_companions where request_id = v_own_req and profile_id = p_driver_id;
    v_was_comp := found;
    update public.requests set requester_id = p_driver_id, filed_by = coalesce(filed_by, v_old_driver),
      adults = case when v_was_comp then greatest(adults - 1, 1) else adults end
    where id = v_own_req;
  end if;
  perform public.assert_ride_driver(r.id);
  perform public.assert_ride_seats_fit(r.id);
  perform public.assert_car_chain(r.car_id, r.week_start);
  v_prev_sys := coalesce(current_setting('app.system_status_transition', true), 'off');
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'merged', status_reason = 'DRIVER_ASSIGNED'
  where id in (select request_id from public.ride_requests where ride_id = r.id) and status in ('waitlisted', 'submitted', 'proposed');
  perform set_config('app.system_status_transition', v_prev_sys, true);

  select full_name into v_driver_name from public.profiles where id = p_driver_id;
  -- R2B18: nobody is told "a driver was found" for a day that is not published yet.
  if public.is_day_public(r.department_id, r.week_start, (r.starts_at at time zone 'Asia/Jerusalem')::date) then
  if v_replace and v_old_driver is distinct from v_actor then
    perform public.enqueue_notification(v_old_driver, 'outcome_changed', r.department_id, r.week_start,
      jsonb_build_object('byName', coalesce(v_by, ''), 'driverName', coalesce(v_driver_name, ''), 'route', v_route, 'day', v_day, 'car', coalesce(v_car, '')),
      jsonb_build_object('variant', 'driver_replaced_you', 'ride_id', r.id),
      format('driver_replaced_you:%s:%s:%s', r.id, r.version, v_old_driver));
  end if;
  if p_driver_id is distinct from v_actor then
    perform public.enqueue_notification(p_driver_id, 'outcome_changed', r.department_id, r.week_start,
      jsonb_build_object('byName', coalesce(v_by, ''), 'route', v_route, 'day', v_day, 'depart', v_depart, 'return', v_ret, 'car', coalesce(v_car, '')),
      jsonb_build_object('variant', 'driver_assigned', 'ride_id', r.id),
      format('driver_assigned:%s:%s:%s', r.id, r.version, p_driver_id));
  end if;
  for p in
    select q.requester_id as pid from public.ride_requests rr join public.requests q on q.id = rr.request_id where rr.ride_id = r.id
    union select rp.person_id from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id is not null
  loop
    continue when p.pid = p_driver_id or p.pid = v_actor or p.pid = v_old_driver;
    perform public.enqueue_notification(p.pid, 'outcome_changed', r.department_id, r.week_start,
      jsonb_build_object('driverName', coalesce(v_driver_name, ''), 'route', v_route, 'day', v_day, 'car', coalesce(v_car, '')),
      jsonb_build_object('variant', case when v_replace then 'driver_changed_passenger' else 'driver_assigned_passenger' end, 'ride_id', r.id),
      format('driver_assigned_passenger:%s:%s:%s', r.id, r.version, p.pid));
  end loop;
  end if;
  return jsonb_build_object('ride_id', r.id, 'driver_id', p_driver_id, 'needs_driver', false);
end $$;

revoke all on function public.claim_ride_driver(uuid, integer, boolean) from public, anon;
revoke all on function public.take_over_ride_driver(uuid, integer, boolean) from public, anon;
revoke all on function public.set_ride_driver(uuid, uuid, integer, boolean) from public, anon;
grant execute on function public.claim_ride_driver(uuid, integer, boolean) to authenticated;
grant execute on function public.take_over_ride_driver(uuid, integer, boolean) to authenticated;
grant execute on function public.set_ride_driver(uuid, uuid, integer, boolean) to authenticated;
