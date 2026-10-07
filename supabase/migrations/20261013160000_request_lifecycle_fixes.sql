-- REQ §13.109 (d)(e)(f) / QA runs 6-7, group C (request lifecycle).
--  R7B9   cancel_ride releases EVERY leg the cancelled request holds (release_request_booking); unassign_ride no longer
--         trips over a cancelled request; a cancelled/withdrawn request is not told "X cancelled a ride you were in".
--  R7B10  a cancelled host ride releases ask-to-join requests that point at it (link cleared, member told).
--  R6B7   asking to join a ride you are already on is refused (join_own_ride).
--  R7B12  origin = destination is refused (origin_equals_destination).
--  R6B8/M1 set_ride_driver replaces a volunteer driver in one step; the old driver is told, passengers once.
--  R6B13  a published-day edit that ends up waiting tells the editor.
--  R7B14  stale flagged rides (car_chain_broken / relay_* / maintenance) are cleared whenever the conflict is gone.
--  R7U4   wording: removal says what happens next, "placed by the Sadran" has its own variant.

CREATE OR REPLACE FUNCTION "public"."cancel_ride_without_passengers"("p_ride_id" "uuid", "p_reason" "text", "p_expected_version" integer DEFAULT NULL::integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ride record;
  v_is_relay boolean;
  v_offer_id uuid;
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_served record;
  v_passenger record;
  v_ta interval; v_day_start timestamptz; v_day_end timestamptz;
  v_prev record; v_next record; v_gap_start timestamptz; v_gap_end timestamptz; v_maint timestamptz;
begin
  select * into v_ride from public.rides where id = p_ride_id for update;
  if v_ride is null or v_ride.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if v_ride.driver_id <> v_actor and not public.can_manage_week(v_ride.department_id, v_ride.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_expected_version is null or v_ride.version <> p_expected_version then
    perform public.raise_stale_version();
  end if;

  perform set_config('app.audit_reason', coalesce(p_reason, 'cancel_ride'), true);

  select exists (select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.car_mode = 'relay')
    into v_is_relay;

  update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor,
    cancel_reason = coalesce(p_reason, 'CANCELLED_BY_MEMBER')
  where id = p_ride_id;

  select full_name into v_actor_name from public.profiles where id = v_actor;

  for v_served in
    select q.id as request_id, q.requester_id
    from public.ride_requests rr join public.requests q on q.id = rr.request_id
    where rr.ride_id = p_ride_id and q.requester_id is distinct from v_actor
      and q.status not in ('cancelled', 'withdrawn')   -- R7B9/R7U4: nobody is told about a request that already ended
  loop
    perform public.enqueue_notification(v_served.requester_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
      jsonb_build_object('byName', coalesce(v_actor_name, '')),
      jsonb_build_object('variant', 'ride_cancelled', 'ride_id', p_ride_id, 'request_id', v_served.request_id),
      format('ride_cancelled:%s:%s:%s', p_ride_id, v_ride.version, v_served.request_id));
  end loop;

  -- Named ride_passengers (F3, 20260914120000): no `requests` row of their own, so they are
  -- never reached by the loop above — notify them the same way.
  for v_passenger in
    select rp.person_id
    from public.ride_passengers rp
    where rp.ride_id = p_ride_id and rp.person_id is not null and rp.person_id is distinct from v_actor
  loop
    perform public.enqueue_notification(v_passenger.person_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
      jsonb_build_object('byName', coalesce(v_actor_name, '')),
      jsonb_build_object('variant', 'ride_cancelled', 'ride_id', p_ride_id),
      format('ride_cancelled:%s:%s:%s', p_ride_id, v_ride.version, v_passenger.person_id));
  end loop;

  update public.requests set status = 'cancelled', status_reason = 'RIDE_CANCELLED'
  where id in (select request_id from public.ride_requests where ride_id = p_ride_id);

  -- REQ §13.89: heal the chain of the car this ride just vacated, reusing its own
  -- origin/destination/times as the hint for whichever gap its removal opened up.
  perform set_config('app.chain_hint', jsonb_build_object('origin_id',v_ride.origin_id,'destination_id',v_ride.destination_id,
    'starts_at',v_ride.starts_at,'ends_at',v_ride.ends_at)::text, true);
  perform public.assert_car_chain(v_ride.car_id, v_ride.week_start);
  -- R2B6: whatever the removal left starting where the car is not gets flagged for the Sadran.
  perform public.flag_car_chain_breaks(v_ride.car_id, v_ride.week_start);

  if v_is_relay then
    -- Still flag the partner leg for the Sadran's attention (REQ §13.63) — the chain
    -- itself is already healed by the assert_car_chain call above.
    update public.rides set status = 'flagged', flag_reason = 'relay_pair_cancelled'
    where car_id = v_ride.car_id and week_start = v_ride.week_start and status <> 'cancelled'
      and (origin_id = v_ride.destination_id or destination_id = v_ride.origin_id) and id <> p_ride_id
      and not public.ride_is_reservation(id);
    return;
  end if;

  -- REQ §13.99: nothing is ever offered from a private (temporary) car; only shared cars free a slot.
  if v_ride.origin_id = v_ride.destination_id
     and exists (select 1 from public.cars c where c.id = v_ride.car_id and c.type = 'shared') then
    -- REQ §13.102 (b): the offer covers the car's whole free gap that day (previous ride end + turnaround
    -- ... next ride start - turnaround), not only the cancelled ride's own hours. A neighbour that does not
    -- leave/expect the car at this ride's place bounds the gap at the cancelled ride itself.
    v_ta := make_interval(mins => coalesce(public.required_turnaround_minutes(v_ride.department_id, v_ride.week_start), 30));
    v_day_start := ((v_ride.starts_at at time zone 'Asia/Jerusalem')::date)::timestamp at time zone 'Asia/Jerusalem';
    v_day_end := (((v_ride.starts_at at time zone 'Asia/Jerusalem')::date + 1)::timestamp at time zone 'Asia/Jerusalem') - interval '1 minute';
    select r.ends_at, r.destination_id into v_prev from public.rides r
    where r.car_id = v_ride.car_id and r.status <> 'cancelled' and r.id <> p_ride_id and r.ends_at <= v_ride.starts_at
      and r.ends_at >= v_day_start and not r.planning_conflict
    order by r.ends_at desc limit 1;
    select r.starts_at, r.origin_id into v_next from public.rides r
    where r.car_id = v_ride.car_id and r.status <> 'cancelled' and r.id <> p_ride_id and r.starts_at >= v_ride.ends_at
      and r.starts_at <= v_day_end and not r.planning_conflict
    order by r.starts_at limit 1;
    select min(b.starts_at) into v_maint from public.car_maintenance_blocks b
    where b.car_id = v_ride.car_id and b.starts_at >= v_ride.ends_at and b.starts_at <= v_day_end;
    v_gap_start := case when v_prev.ends_at is null then v_day_start
                        when v_prev.destination_id is distinct from v_ride.origin_id then v_ride.starts_at
                        else least(v_prev.ends_at + v_ta, v_ride.starts_at) end;
    v_gap_end := case when v_next.starts_at is null then v_day_end
                      when v_next.origin_id is distinct from v_ride.destination_id then v_ride.ends_at
                      else greatest(v_next.starts_at - v_ta, v_ride.ends_at) end;
    if v_maint is not null then v_gap_end := greatest(least(v_gap_end, v_maint), v_ride.ends_at); end if;
    insert into public.freed_slot_offers (department_id, week_start, car_id, cancelled_ride_id, starts_at, ends_at, expires_at)
    values (v_ride.department_id, v_ride.week_start, v_ride.car_id, p_ride_id, v_gap_start, v_gap_end, v_ride.starts_at)
    returning id into v_offer_id;

    -- Notify the on-ride-cancelled edge function (pg_net) if configured; a no-op locally
    -- until app_settings.on_ride_cancelled_url is set, so this never breaks db reset/tests.
    perform net.http_post(
      url := cfg.url_val,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', coalesce(cfg.secret_val, '')),
      body := jsonb_build_object('offer_id', v_offer_id)
    )
    from (
      select
        (select value ->> 'value' from public.app_settings where key = 'on_ride_cancelled_url') as url_val,
        (select value ->> 'value' from public.app_secrets where key = 'cron_secret') as secret_val
    ) cfg
    where cfg.url_val is not null and cfg.url_val <> '';
  end if;
end;
$$;

create or replace function public.cancel_ride(p_ride_id uuid, p_reason text, p_expected_version integer default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_series uuid; v_req uuid; v_reqs uuid[];
begin
  select series_id into v_series from public.rides where id = p_ride_id;
  select array_agg(request_id) into v_reqs from public.ride_requests where ride_id = p_ride_id;
  perform public.cancel_ride_before_series(p_ride_id, p_reason, p_expected_version);
  if v_series is null then
    -- R7B9 (REQ §13.109 f): a request this cancellation ended must not keep holding its other legs (a הקפצה's
    -- outbound ride): every other ride it is on is cancelled, or the member is taken off it (the ride then needs a
    -- driver) and the people sharing it are told.
    for v_req in
      select q.id from public.requests q
      where q.id = any(coalesce(v_reqs, '{}'::uuid[])) and q.status = 'cancelled'
        and exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                    where rr.request_id = q.id and r.status <> 'cancelled')
      order by q.id
    loop
      perform public.release_request_booking(v_req);
    end loop;
    return;
  end if;
  -- A passenger removing only their own seat does not cancel the ride, and must not
  -- cancel the series either.
  if not exists (select 1 from public.rides where id = p_ride_id and status = 'cancelled') then return; end if;

  perform set_config('app.audit_reason', coalesce(p_reason, 'series_cancelled'), true);
  perform set_config('app.system_status_transition', 'on', true);
  update public.rides set status = 'cancelled', cancelled_at = now(),
    cancelled_by = coalesce((select auth.uid()), driver_id, created_by),
    cancel_reason = coalesce(p_reason, 'SERIES_CANCELLED')
  where series_id = v_series and status <> 'cancelled';
  update public.requests set status = 'cancelled', status_reason = 'RIDE_CANCELLED'
  where series_id = v_series and status not in ('cancelled', 'withdrawn');
  perform set_config('app.system_status_transition', 'off', true);
end $$;

CREATE OR REPLACE FUNCTION "public"."unassign_ride"("p_ride_id" "uuid", "p_expected_version" integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare r public.rides%rowtype; ids uuid[];
begin
  select * into r from public.rides where id=p_ride_id for update;
  if not found or r.status='cancelled' then raise exception 'ride_not_found'; end if;
  if not public.can_manage_week(r.department_id,r.week_start) then raise exception 'not_authorized'; end if;
  if p_expected_version is null or r.version<>p_expected_version then perform public.raise_stale_version(); end if;
  if exists(select 1 from public.weeks where department_id=r.department_id and week_start=r.week_start and phase='archived') then raise exception 'week_archived'; end if;
  perform set_config('app.audit_reason','unassign_ride',true);
  select array_agg(request_id) into ids from public.ride_requests where ride_id=r.id;
  update public.rides set status='cancelled',cancelled_at=now(),cancelled_by=(select auth.uid()),cancel_reason='SADRAN_UNASSIGNED' where id=r.id;
  delete from public.ride_requests where ride_id=r.id;
  update public.requests q set status='waitlisted',status_reason='SADRAN_UNASSIGNED' where id=any(ids)
    and q.status not in ('cancelled','withdrawn','denied','external')   -- R7B9: a request that already ended stays ended
    and not exists(select 1 from public.ride_requests rr join public.rides rd on rd.id=rr.ride_id where rr.request_id=q.id and rd.status<>'cancelled');
  perform set_config('app.chain_hint', jsonb_build_object('origin_id',r.origin_id,'destination_id',r.destination_id,
    'starts_at',r.starts_at,'ends_at',r.ends_at)::text, true);
  perform public.assert_car_chain(r.car_id,r.week_start);
end $$;


ALTER FUNCTION "public"."unassign_ride"("p_ride_id" "uuid", "p_expected_version" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."unmerge_request"("p_ride_id" "uuid", "p_request_id" "uuid", "p_expected_version" integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ride public.rides%rowtype;
  v_actor uuid := (select auth.uid());
  v_guest public.requests%rowtype;
  v_base uuid; v_base_return timestamptz; v_base_depart timestamptz;
  v_before int; v_after int; v_delta int; v_b_out int; v_a_out int; v_b_ret int; v_a_ret int;
  v_start timestamptz; v_end timestamptz; v_prev_sys text; v_new_window boolean;
  v_actor_name text; v_dest_name text; v_route text;
begin
  select * into v_ride from public.rides where id = p_ride_id for update;
  if not found or v_ride.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_ride.department_id, v_ride.week_start) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_expected_version is null or v_ride.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if exists (select 1 from public.weeks w where w.department_id = v_ride.department_id and w.week_start = v_ride.week_start and w.phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;

  select * into v_guest from public.requests q where q.id = p_request_id;
  if v_guest.id is null or v_guest.department_id <> v_ride.department_id
     or not exists (select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.request_id = p_request_id) then
    raise exception 'request_not_on_ride' using errcode = 'P0001';
  end if;

  select rr.request_id into v_base from public.ride_requests rr where rr.ride_id = p_ride_id
  order by (rr.role = 'driver') desc, rr.created_at, rr.request_id limit 1;
  if v_base = p_request_id
     or exists (select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.request_id = p_request_id and rr.role = 'driver')
     or v_ride.driver_id is not distinct from v_guest.requester_id then
    raise exception 'unmerge_base_request' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'unmerge_request', true);
  v_b_out := public.ride_route_minutes(p_ride_id, 'out'); v_b_ret := public.ride_route_minutes(p_ride_id, 'return');
  v_before := public.ride_route_minutes(p_ride_id, 'both');
  delete from public.ride_requests where ride_id = p_ride_id and request_id = p_request_id;
  v_a_out := public.ride_route_minutes(p_ride_id, 'out'); v_a_ret := public.ride_route_minutes(p_ride_id, 'return');
  v_after := public.ride_route_minutes(p_ride_id, 'both');
  v_delta := greatest(coalesce(v_before, 0) - coalesce(v_after, 0), 0);

  select case when rr2.covers_return then q.return_at end, case when rr2.covers_out then q.depart_at end
    into v_base_return, v_base_depart
  from public.ride_requests rr2 join public.requests q on q.id = rr2.request_id
  where rr2.ride_id = p_ride_id and rr2.request_id = v_base limit 1;

  v_start := v_ride.starts_at; v_end := v_ride.ends_at;
  v_new_window := v_base_depart is not null and v_ride.starts_at < v_base_depart;
  if v_new_window then
    if greatest(coalesce(v_b_out, 0) - coalesce(v_a_out, 0), 0) > 0 then
      v_start := least(v_ride.starts_at + make_interval(mins => (ceil(greatest(v_b_out - v_a_out, 0) / 15.0) * 15)::int), v_base_depart);
    end if;
    v_delta := greatest(coalesce(v_b_ret, 0) - coalesce(v_a_ret, 0), 0);
  end if;
  if v_delta > 0 then
    -- 23:59 is the capped "end of day": treat it as 24:00 so the quarter-hour arithmetic inverts apply.
    if (v_end at time zone 'Asia/Jerusalem')::time = time '23:59' then v_end := v_end + interval '1 minute'; end if;
    v_end := v_end - make_interval(mins => (ceil(v_delta / 15.0) * 15)::int);
    v_end := greatest(v_end, coalesce(v_base_return, v_end), v_start + interval '15 minutes');
    v_end := least(public._round_up_ride_end(v_start, v_end), v_ride.ends_at);
  end if;

  update public.rides set starts_at = v_start, ends_at = v_end, updated_at = now() where id = p_ride_id;
  perform public.refresh_car_turnarounds(v_ride.car_id, v_ride.week_start);

  if not exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                 where rr.request_id = p_request_id and r.status <> 'cancelled') then
    v_prev_sys := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'submitted', status_reason = 'UNMERGED_BY_SADRAN' where id = p_request_id;
    perform set_config('app.system_status_transition', v_prev_sys, true);
  end if;

  if v_guest.requester_id is distinct from v_actor then
    select full_name into v_actor_name from public.profiles where id = v_actor;
    select name into v_dest_name from public.destinations where id = coalesce(v_guest.destination_id, v_ride.destination_id);
    v_route := public.route_label(v_guest.department_id, v_guest.origin_id, v_guest.origin_text, v_guest.destination_id, v_guest.destination_text);
    perform public.enqueue_notification(v_guest.requester_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
      jsonb_build_object('byName', coalesce(v_actor_name, ''), 'destination', coalesce(v_dest_name, ''),
        'route', coalesce(v_route, ''), 'day', public.day_date_label(v_ride.starts_at)),
      jsonb_build_object('variant', 'passenger_removed_you', 'ride_id', p_ride_id, 'request_id', p_request_id),
      format('unmerge:%s:%s:%s', p_ride_id, p_request_id, v_ride.version));
  end if;
end;
$$;
CREATE OR REPLACE FUNCTION "public"."set_ride_driver"("p_ride_id" "uuid", "p_driver_id" "uuid", "p_expected_version" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  r public.rides%rowtype; v_actor uuid := (select auth.uid()); v_by text; v_driver_name text; v_car text;
  v_route text; v_day text; v_depart text; v_ret text; p record; v_notified uuid[] := '{}';
  v_old_driver uuid; v_replace boolean := false;
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
    if r.driver_id is null or r.driver_id = p_driver_id
       or not exists (select 1 from public.ride_requests where ride_id = r.id)
       or exists (select 1 from public.ride_requests where ride_id = r.id and role = 'driver') then
      raise exception 'ride_driver_not_assignable' using errcode = 'P0001';
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
  if exists (select 1 from public.rides x where x.driver_id = p_driver_id and x.id <> r.id and x.status <> 'cancelled'
             and tstzrange(x.starts_at, x.ends_at, '[)') && tstzrange(r.starts_at, r.ends_at, '[)')) then
    raise exception 'driver_already_busy' using errcode = 'P0001';
  end if;
  -- REQ §13.103 R3B22: a volunteer who rides elsewhere (own request, named passenger, companion) at that time cannot drive.
  if exists (
    select 1 from public.rides x
    where x.id <> r.id and x.status <> 'cancelled' and tstzrange(x.starts_at, x.ends_at, '[)') && tstzrange(r.starts_at, r.ends_at, '[)')
      and (exists (select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
                   where rr.ride_id = x.id and q.requester_id = p_driver_id)
        or exists (select 1 from public.ride_passengers rp where rp.ride_id = x.id and rp.person_id = p_driver_id)
        or exists (select 1 from public.ride_requests rr join public.request_companions rc on rc.request_id = rr.request_id
                   where rr.ride_id = x.id and rc.profile_id = p_driver_id))
  ) then
    raise exception 'driver_busy' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', case when v_replace then 'replace_ride_driver' else 'set_ride_driver' end, true);
  update public.rides set driver_id = p_driver_id, needs_driver = false,
    status = case when status = 'flagged' and flag_reason = 'NEEDS_DRIVER' then 'confirmed'::public.ride_status else status end,
    flag_reason = case when flag_reason = 'NEEDS_DRIVER' then null else flag_reason end
  where id = r.id;
  perform public.assert_ride_driver(r.id);
  perform public.assert_ride_seats_fit(r.id);
  perform public.assert_car_chain(r.car_id, r.week_start);
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'merged', status_reason = 'DRIVER_ASSIGNED'
  where id in (select request_id from public.ride_requests where ride_id = r.id) and status in ('waitlisted', 'submitted', 'proposed');
  perform set_config('app.system_status_transition', 'off', true);

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


ALTER FUNCTION "public"."set_ride_driver"("p_ride_id" "uuid", "p_driver_id" "uuid", "p_expected_version" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_ride_passengers"("p_ride_id" "uuid", "p_expected_version" integer, "p_passengers" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ride public.rides%rowtype;
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_item jsonb;
  v_person_id uuid;
  v_child_id uuid;
  v_display_name text;
  v_seat_kind text;
  v_old_person_ids uuid[];
  v_new_person_ids uuid[] := '{}';
  v_added_person_ids uuid[];
  v_existing_a int; v_existing_c int; v_existing_b int;
  v_new_a int := 0; v_new_c int := 0; v_new_b int := 0;
  v_chauffeur_bonus int;
  v_new_version int;
begin
  select * into v_ride from public.rides where id = p_ride_id for update;
  if not found or v_ride.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_ride.department_id, v_ride.week_start) and v_ride.driver_id is distinct from v_actor then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_expected_version is null or v_ride.version <> p_expected_version then
    perform public.raise_stale_version();
  end if;
  if exists (select 1 from public.weeks where department_id = v_ride.department_id and week_start = v_ride.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;

  select array_agg(person_id) filter (where person_id is not null) into v_old_person_ids
  from public.ride_passengers where ride_id = p_ride_id;

  -- Validate every row and total the new seat load before writing anything.
  for v_item in select * from jsonb_array_elements(coalesce(p_passengers, '[]'::jsonb))
  loop
    v_person_id := nullif(v_item ->> 'person_id', '')::uuid;
    v_child_id := nullif(v_item ->> 'child_id', '')::uuid;
    v_display_name := nullif(trim(coalesce(v_item ->> 'display_name', '')), '');
    v_seat_kind := v_item ->> 'seat_kind';
    if v_person_id is not null and v_child_id is not null then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
    if v_display_name is null then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
    if v_person_id is not null and not exists (
      select 1 from public.profiles p join public.department_members dm on dm.profile_id = p.id
      where p.id = v_person_id and p.approval_status = 'approved'
        and dm.department_id = v_ride.department_id and dm.removed_at is null
    ) then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
    if v_child_id is not null and not exists (
      select 1 from public.children c where c.id = v_child_id and c.department_id = v_ride.department_id
    ) then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
    if v_person_id is not null then
      v_new_person_ids := v_new_person_ids || v_person_id;
    end if;
    case v_seat_kind
      when 'adult' then v_new_a := v_new_a + 1;
      when 'child_seat' then v_new_c := v_new_c + 1;
      when 'booster' then v_new_b := v_new_b + 1;
      else raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end case;
  end loop;

  if cardinality(v_new_person_ids) <> (select count(distinct x) from unnest(v_new_person_ids) x) then
    raise exception 'invalid_ride_passenger' using errcode = 'P0001';
  end if;

  -- Seat capacity: car seats minus the ride's served `ride_requests` load (with the same
  -- driver-has-no-request-of-their-own bonus `assert_ride_seats_fit` applies) minus these rows.
  select coalesce(sum(q.adults), 0), coalesce(sum(q.child_seats), 0), coalesce(sum(q.boosters), 0)
    into v_existing_a, v_existing_c, v_existing_b
  from public.ride_requests rr join public.requests q on q.id = rr.request_id
  where rr.ride_id = p_ride_id;

  v_chauffeur_bonus := case when v_ride.driver_id is not null
    and not exists (select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.role = 'driver')
    then 1 else 0 end;

  if not public.car_fits(v_ride.car_id, v_existing_a + v_chauffeur_bonus + v_new_a, v_existing_c + v_new_c, v_existing_b + v_new_b) then
    raise exception 'ride_seats_exceeded' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'set_ride_passengers', true);

  delete from public.ride_passengers where ride_id = p_ride_id;
  for v_item in select * from jsonb_array_elements(coalesce(p_passengers, '[]'::jsonb))
  loop
    insert into public.ride_passengers (ride_id, department_id, week_start, person_id, child_id, display_name, seat_kind, added_by)
    values (p_ride_id, v_ride.department_id, v_ride.week_start,
      nullif(v_item ->> 'person_id', '')::uuid, nullif(v_item ->> 'child_id', '')::uuid,
      trim(v_item ->> 'display_name'), v_item ->> 'seat_kind', v_actor);
  end loop;

  -- Optimistic concurrency: any update fires `bump_version()` (20260907090800_rides.sql).
  update public.rides set updated_at = now() where id = p_ride_id
  returning version into v_new_version;

  select array_agg(x) into v_added_person_ids
  from unnest(v_new_person_ids) x
  where x <> all (coalesce(v_old_person_ids, '{}'::uuid[])) and x is distinct from v_actor;

  if v_added_person_ids is not null then
    select full_name into v_actor_name from public.profiles where id = v_actor;
    for v_person_id in select unnest(v_added_person_ids) loop
      perform public.enqueue_notification(v_person_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('byName', coalesce(v_actor_name, '')),
        jsonb_build_object('variant', 'reservation_added', 'ride_id', p_ride_id),
        format('reservation_added:%s:%s:%s', p_ride_id, v_new_version, v_person_id));
    end loop;
  end if;
end;
$$;CREATE OR REPLACE FUNCTION "public"."submit_request"("payload" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
  v_join_owner uuid;
  v_auto_result jsonb;
  v_companion_ids uuid[];
  v_series_id uuid := nullif(payload ->> 'series_id', '')::uuid;
  v_series_index smallint := nullif(payload ->> 'series_index', '')::smallint;
  v_series_count smallint := nullif(payload ->> 'series_count', '')::smallint;
  v_eligible_driver uuid;
  v_kept timestamptz; v_prev_return timestamptz; v_prev_kept timestamptz;
  v_own_overlap boolean := false;
  v_published_edit boolean := false; v_old_edit_car uuid;
  v_confirm boolean := coalesce((payload ->> 'confirm_release')::boolean, false);
  v_booking jsonb;
  v_probe jsonb;
  v_overlaps jsonb := '[]'::jsonb;
  v_probe_only boolean := coalesce((payload ->> 'probe_only')::boolean, false);
  v_late_variant text;
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

  if v_request_id is not null then
    select * into v_existing from public.requests where id = v_request_id for update;
    if v_existing is null then
      raise exception 'request_not_found' using errcode = 'P0001';
    end if;
    if v_existing.requester_id <> v_actor and not public.can_manage_week(v_existing.department_id, v_existing.week_start) then
      raise exception 'not_authorized' using errcode = 'P0001';
    end if;
    if v_existing.department_id is distinct from v_department_id or v_existing.week_start is distinct from v_week_start or v_existing.requester_id is distinct from v_requester_id then raise exception 'not_authorized'; end if;
    -- REQ §13.77 v1: a multi-day series is cancelled and resubmitted, never edited leg by leg.
    if v_existing.series_id is not null or v_series_id is not null then
      raise exception 'series_edit_not_supported' using errcode = 'MDR02';
    end if;
    -- REQ §13.101 (f): on a published/live day the requester may edit their own request; the new
    -- version is placed (or released to the waiting list after a confirmation). A closed, unpublished
    -- day keeps request_window_closed (the member contacts the Sadran).
    v_published_edit := v_week.phase in ('published', 'live') and v_requester_id = v_actor;
    if v_published_edit then
      if coalesce(v_existing.return_at, v_existing.depart_at) < now() then raise exception 'request_not_editable'; end if;
    elsif not v_can_manage and (v_week.phase not in ('open','solving') or now() > v_week.close_at or now() < v_week.open_at) then raise exception 'request_window_closed'; end if;
    if v_existing.status in ('cancelled','withdrawn') or (not v_published_edit and exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=v_request_id and r.status not in ('draft','cancelled'))) then raise exception 'request_not_editable'; end if;
    -- REQ §13.102 (f), R2B20: the form asks before saving whether an edit would lose the current booking.
    if v_probe_only then
      return jsonb_build_object('probe_only', true, 'request_id', v_request_id,
        'would_lose_booking', v_existing.status in ('assigned', 'merged', 'proposed') or exists (
          select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
          where rr.request_id = v_request_id and r.status <> 'cancelled'));
    end if;
    if not (payload ? 'expected_version') then perform public.raise_stale_version(); end if;
    if v_existing.version is distinct from (payload ->> 'expected_version')::int then
      perform public.raise_stale_version();
    end if;
    if v_published_edit then
      v_booking := public.request_booking_info(v_request_id);
      if (v_booking ->> 'has_booking')::boolean and not v_confirm then
        -- Probe: run the whole edit (release + new placement) in a subtransaction. A clean move onto a
        -- free car (nobody left behind) is kept; anything else is rolled back and the member is asked.
        begin
          v_probe := public.submit_request(payload || jsonb_build_object('confirm_release', true));
          if coalesce(v_probe ->> 'status', '') = 'assigned' and not (v_booking ->> 'drives_others')::boolean then
            return v_probe;
          end if;
          raise exception 'release_probe_rollback' using errcode = 'PXRP1';
        exception when sqlstate 'PXRP1' then
          null;
        end;
        -- would_place: the probe found a car (only asked because the member drives others).
        return jsonb_build_object('needs_confirmation', 'release_to_waitlist',
          'drives_others', (v_booking ->> 'drives_others')::boolean,
          'would_place', coalesce(v_probe ->> 'status', '') = 'assigned');
      end if;
    end if;
  end if;

  if v_probe_only then
    return jsonb_build_object('probe_only', true, 'would_lose_booking', false);
  end if;

  -- A one-way shape stores no return_at: remember the last real one (payload, else the stored one) in
  -- kept_return_at; a shape that needs a return and got none gets the kept one back.
  if v_request_id is not null then
    v_prev_return := v_existing.return_at; v_prev_kept := v_existing.kept_return_at;
  end if;
  if v_trip_shape = 'one_way_to' then
    v_kept := coalesce(v_return_at, v_prev_return, v_prev_kept);
    v_return_at := null;
  else
    v_return_at := coalesce(v_return_at, v_prev_kept);
  end if;

  if coalesce((payload->>'reserve_missing_driver')::boolean,false) and (
    v_request_id is not null or v_requester_id is distinct from v_actor or v_week.phase<>'live' or v_trip_shape='round_trip' or v_trip_type<>'drop_off' or v_join_ride_id is not null
  ) then raise exception 'invalid_quick_reservation';end if;
  if v_request_id is not null then perform public.release_request_draft_rides(v_request_id); end if;
  if v_request_id is not null and v_published_edit and coalesce((v_booking ->> 'has_booking')::boolean, false) then
    -- confirmed (or probed) release of the old booking; the request starts over as `submitted`.
    -- R3B14: remember the booked car so the re-placement keeps it when it still fits.
    select r.car_id into v_old_edit_car from public.ride_requests rr join public.rides r on r.id = rr.ride_id
    where rr.request_id = v_request_id and r.status <> 'cancelled' order by r.starts_at limit 1;
    perform set_config('app.edit_prefer_car', coalesce(v_old_edit_car::text, ''), true);
    perform public.release_request_booking(v_request_id);
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'submitted', status_reason = null where id = v_request_id;
    perform set_config('app.system_status_transition', 'off', true);
  end if;

  v_is_late := now() > v_week.close_at;
  -- R2U4: a late request tells the Sadranim once (below), with its outcome, instead of late + waitlisted + contested.
  perform set_config('app.late_request_notice', case when v_is_late and v_series_id is null and not coalesce((payload->>'reserve_missing_driver')::boolean,false) then 'on' else 'off' end, true);

  perform set_config('app.audit_reason', 'submit_request', true);

  perform set_config('app.reset_request_baseline',case when v_requester_id=v_actor then 'on' else 'off' end,true);
  if v_request_id is null then
    v_status := 'submitted';
    insert into public.requests (
      department_id, week_start, requester_id, filed_by, destination_id, destination_text, ride_type_id,
      origin_id, origin_text, trip_type,
      trip_shape, depart_at, return_at, one_way_car_mode, needs_car_at_destination,
      adults, child_seats, boosters, has_luggage,
      flex_depart_early, flex_depart_late, flex_return_early, flex_return_late,
      notes, is_late, submitted_at, status, freed_slot_opt_out, join_ride_id, template_id, preferred_car_id,
      series_id, series_index, series_count, kept_return_at
    ) values (
      v_department_id, v_week_start, v_requester_id, v_actor,
      nullif(payload ->> 'destination_id', '')::uuid, nullif(payload ->> 'destination_text', ''),
      (payload ->> 'ride_type_id')::uuid,
      v_origin_id, v_origin_text, v_trip_type,
      v_trip_shape, v_depart_at, v_return_at, v_one_way_mode, v_needs_car,
      coalesce((payload ->> 'adults')::smallint, 1), coalesce((payload ->> 'child_seats')::smallint, 0),
      coalesce((payload ->> 'boosters')::smallint, 0), coalesce((payload ->> 'has_luggage')::boolean, false),
      coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_return_early', '')::interval, '0'),
      coalesce(nullif(payload ->> 'flex_return_late', '')::interval, '0'),
      nullif(payload ->> 'notes', ''), v_is_late, now(), v_status,
      coalesce((payload ->> 'freed_slot_opt_out')::boolean, false),
      v_join_ride_id, nullif(payload ->> 'template_id', '')::uuid, v_preferred_car_id,
      v_series_id, v_series_index, v_series_count, v_kept
    ) returning id into v_request_id;
  else
    update public.requests set
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
      flex_depart_early = coalesce(nullif(payload ->> 'flex_depart_early', '')::interval, flex_depart_early),
      flex_depart_late = coalesce(nullif(payload ->> 'flex_depart_late', '')::interval, flex_depart_late),
      flex_return_early = coalesce(nullif(payload ->> 'flex_return_early', '')::interval, flex_return_early),
      flex_return_late = coalesce(nullif(payload ->> 'flex_return_late', '')::interval, flex_return_late),
      notes = case when payload ? 'notes' then nullif(payload ->> 'notes','') else notes end,
      is_late = v_is_late,
      freed_slot_opt_out = coalesce((payload ->> 'freed_slot_opt_out')::boolean, freed_slot_opt_out),
      join_ride_id = coalesce(v_join_ride_id, join_ride_id),
      preferred_car_id = case when payload ? 'preferred_car_id' then v_preferred_car_id else preferred_car_id end,
      changed_since_solve = (v_week.phase not in ('open','solving'))
    where id = v_request_id
    returning status into v_status;

    if v_week.phase in ('solving','published','live') then
      perform public.enqueue_notification(s.profile_id, 'request_changed', v_department_id, v_week_start,
        jsonb_build_object('requestId', v_request_id::text), jsonb_build_object('request_id', v_request_id),
        format('request_changed:%s:%s', v_request_id, now()))
      from public.sadranim_of(v_department_id, v_week_start) as s(profile_id);
    end if;
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
  if v_series_id is null and not v_own_overlap and exists (
    select 1 from public.rides r
    where r.department_id = v_department_id and r.status not in ('cancelled', 'draft')
      and (r.driver_id = v_requester_id
           or exists (select 1 from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id = v_requester_id))
      and not exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = v_request_id)
      and tstzrange(r.starts_at, r.ends_at, '[)') && public.request_span(v_depart_at, v_return_at)
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
        where r.department_id = v_department_id and r.status not in ('cancelled', 'draft')
          and (r.driver_id = v_requester_id
               or exists (select 1 from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id = v_requester_id))
          and not exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = v_request_id)
          and tstzrange(r.starts_at, r.ends_at, '[)') && public.request_span(v_depart_at, v_return_at)
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

  -- Placement on submit (REQ §13.93/§13.94): only round_trip and an explicit one_way ("I take the
  -- car") go through try_auto_approve() once a week is published/live. Every drop_off, with or
  -- without a pickup, is two separate trips for the Sadran/solver: waitlisted in a live week.
  if coalesce((payload->>'reserve_missing_driver')::boolean,false) then
    v_auto_result:=public.reserve_live_one_way_slot(v_request_id);
    perform public.enqueue_notification(s.profile_id,'waitlisted_request',v_department_id,v_week_start,
      jsonb_build_object('requestId',v_request_id::text),jsonb_build_object('request_id',v_request_id,'ride_id',v_auto_result->>'ride_id'),
      format('waitlisted_request:%s',v_request_id)) from public.sadranim_of(v_department_id,v_week_start) as s(profile_id)
    where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on';
  elsif v_own_overlap and v_week.phase in ('published', 'live') and v_trip_type in ('round_trip', 'one_way') then
    -- REQ §13.100 (QB8): never auto-approved onto another car while the member already has a ride or
    -- request in that time; it stays for the Sadran (waitlisted in a live week, submitted otherwise).
    if v_week.phase = 'live' then
      perform set_config('app.system_status_transition', 'on', true);
      update public.requests set status = 'waitlisted', status_reason = 'DUPLICATE_OVERLAP' where id = v_request_id;
      perform set_config('app.system_status_transition', 'off', true);
    end if;
    perform public.enqueue_notification(s.profile_id, 'waitlisted_request', v_department_id, v_week_start,
      jsonb_build_object('requestId', v_request_id::text),
      jsonb_build_object('request_id', v_request_id, 'variant', 'duplicate_overlap'),
      format('waitlisted_request:%s', v_request_id))
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id)
    where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on';
    v_auto_result := jsonb_build_object('status', case when v_week.phase = 'live' then 'waitlisted' else 'submitted' end,
      'reason', 'DUPLICATE_OVERLAP');
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
    v_auto_result := public.try_auto_approve(v_request_id);
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
    where coalesce(current_setting('app.late_request_notice', true), 'off') <> 'on';
      v_auto_result := coalesce(v_auto_result, '{}'::jsonb)
        || jsonb_build_object('status', 'waitlisted', 'reason', coalesce(v_auto_result ->> 'reason', 'WAITLISTED_EDITED'));
    end if;
    -- R6B13: the editor is told the edit was saved and the request now waits (nothing was said before).
    perform public.enqueue_notification(v_requester_id, 'outcome_changed', v_department_id, v_week_start,
      '{}'::jsonb, jsonb_build_object('variant', 'edit_waitlisted', 'request_id', v_request_id),
      format('edit_waitlisted:%s:%s', v_request_id, clock_timestamp()));
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
    from public.sadranim_of(v_department_id, v_week_start) as s(profile_id);
  end if;
  perform set_config('app.late_request_notice', 'off', true);

  -- R2B20: a post-publish edit that was placed straight away is confirmed to the member.
  perform set_config('app.edit_prefer_car', '', true);
  if v_published_edit and coalesce(v_auto_result->>'status', '') = 'assigned' then
    -- R3B14: when the car changed, the confirmation says old -> new including the car.
    if v_old_edit_car is not null and (v_auto_result->>'car_id') is not null and (v_auto_result->>'car_id')::uuid <> v_old_edit_car then
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
  end if;

  return jsonb_build_object('request_id', v_request_id, 'is_late', v_is_late, 'warnings', v_warnings, 'overlaps', v_overlaps)
    || coalesce(v_auto_result, '{}'::jsonb);
end;
$$;CREATE OR REPLACE FUNCTION "public"."remove_ride_person"("p_ride_id" "uuid", "p_expected_version" integer, "p_key" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ride public.rides%rowtype;
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_destination_name text;
  v_route text;
  v_prefix text;
  v_request_id uuid;
  v_profile_id uuid;
  v_child_id uuid;
  v_ride_passenger_id uuid;
  v_n int;
  v_display_name text;
  v_new_version int;
  v_removed_person_id uuid;
  v_removed_child_id uuid;
  v_removed_display_name text;
  v_skip_notify boolean := false;
  v_guardian record;
begin
  select * into v_ride from public.rides where id = p_ride_id for update;
  if not found or v_ride.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;

  if not public.member_of(v_ride.department_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if not (public.is_week_public(v_ride.department_id, v_ride.week_start) or public.can_manage_week(v_ride.department_id, v_ride.week_start)) then
    raise exception 'ride_week_not_public' using errcode = 'P0001';
  end if;

  if p_expected_version is null or v_ride.version <> p_expected_version then
    perform public.raise_stale_version();
  end if;

  if exists (select 1 from public.weeks where department_id = v_ride.department_id and week_start = v_ride.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;

  v_prefix := split_part(coalesce(p_key, ''), ':', 1);
  perform set_config('app.audit_reason', 'remove_ride_person', true);

  if v_prefix = 'driver' then
    raise exception 'ride_driver_not_removable' using errcode = 'P0001';

  elsif v_prefix = 'added' then
    v_ride_passenger_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    select person_id, child_id, display_name into v_removed_person_id, v_removed_child_id, v_removed_display_name
    from public.ride_passengers where id = v_ride_passenger_id and ride_id = p_ride_id;
    if not found then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    delete from public.ride_passengers where id = v_ride_passenger_id;
    v_skip_notify := v_removed_person_id is null and v_removed_child_id is null; -- free-text guest

  elsif v_prefix = 'comp' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    v_profile_id := nullif(split_part(p_key, ':', 3), '')::uuid;
    if v_request_id is null or v_profile_id is null
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    select full_name into v_removed_display_name from public.profiles where id = v_profile_id;
    delete from public.request_companions where request_id = v_request_id and profile_id = v_profile_id;
    update public.requests set updated_at = now() where id = v_request_id;
    v_removed_person_id := v_profile_id;

  elsif v_prefix = 'child' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    v_child_id := nullif(split_part(p_key, ':', 3), '')::uuid;
    if v_request_id is null or v_child_id is null
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    select full_name into v_removed_display_name from public.children where id = v_child_id;
    delete from public.request_children where request_id = v_request_id and child_id = v_child_id;
    update public.requests set updated_at = now() where id = v_request_id;
    v_removed_child_id := v_child_id;

  elsif v_prefix = 'guest' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    v_n := nullif(split_part(p_key, ':', 3), '')::int;
    if v_request_id is null or v_n is null or v_n < 1
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    update public.requests
      set guest_passenger_names = guest_passenger_names[1 : v_n - 1] || guest_passenger_names[v_n + 1 : cardinality(guest_passenger_names)]
      where id = v_request_id and v_n <= cardinality(guest_passenger_names);
    if not found then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    v_skip_notify := true; -- free-text guest: nobody is notified

  elsif v_prefix = 'req' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    if v_request_id is null then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    select requester_id into v_profile_id from public.requests where id = v_request_id;
    if v_profile_id is null
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    if v_profile_id = v_ride.driver_id then
      raise exception 'ride_driver_not_removable' using errcode = 'P0001';
    end if;
    select full_name into v_removed_display_name from public.profiles where id = v_profile_id;
    delete from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id;
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'withdrawn', status_reason = 'WITHDRAWN_BY_MEMBER' where id = v_request_id;
    perform set_config('app.system_status_transition', 'off', true);
    v_removed_person_id := v_profile_id;

  else
    raise exception 'invalid_ride_passenger' using errcode = 'P0001';
  end if;

  update public.rides set updated_at = now() where id = p_ride_id
  returning version into v_new_version;

  if not v_skip_notify then
    select full_name into v_actor_name from public.profiles where id = v_actor;

    -- The driver is always told who was removed, unless the driver is the one removing them.
    if v_ride.driver_id is not null and v_ride.driver_id is distinct from v_actor then
      perform public.enqueue_notification(v_ride.driver_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('byName', coalesce(v_actor_name, ''), 'names', coalesce(v_removed_display_name, '')),
        jsonb_build_object('variant', 'passengers_removed', 'ride_id', p_ride_id),
        format('passengers_removed:%s:%s:%s', p_ride_id, v_new_version, v_ride.driver_id));
    end if;

    if v_removed_person_id is not null and v_removed_person_id is distinct from v_actor then
      select name into v_destination_name from public.destinations where id = v_ride.destination_id;
      v_route := public.route_label(v_ride.department_id, v_ride.origin_id, null, v_ride.destination_id, null);
      perform public.enqueue_notification(v_removed_person_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('byName', coalesce(v_actor_name, ''), 'destination', coalesce(v_destination_name, ''), 'route', coalesce(v_route, '')),
        jsonb_build_object('variant', case when v_prefix = 'req' then 'passenger_removed_request' else 'passenger_removed_you' end, 'ride_id', p_ride_id),
        format('passenger_removed_you:%s:%s:%s', p_ride_id, v_new_version, v_removed_person_id));
    end if;

    if v_removed_child_id is not null then
      select name into v_destination_name from public.destinations where id = v_ride.destination_id;
      v_route := public.route_label(v_ride.department_id, v_ride.origin_id, null, v_ride.destination_id, null);
      for v_guardian in select cg.profile_id from public.child_guardians cg where cg.child_id = v_removed_child_id loop
        if v_guardian.profile_id is distinct from v_actor then
          perform public.enqueue_notification(v_guardian.profile_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
            jsonb_build_object('byName', coalesce(v_actor_name, ''), 'childName', coalesce(v_removed_display_name, ''), 'destination', coalesce(v_destination_name, ''), 'route', coalesce(v_route, '')),
            jsonb_build_object('variant', 'child_removed', 'ride_id', p_ride_id),
            format('child_removed:%s:%s:%s:%s', p_ride_id, v_new_version, v_removed_child_id, v_guardian.profile_id));
        end if;
      end loop;
    end if;
  end if;
end;
$$;
-- ---------------------------------------------------------------------------------------------------------
-- R7B10 (REQ §13.109 f): a host ride that is cancelled releases the ask-to-join requests pointing at it.
create or replace function public.rides_release_join_requests() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare q record; v_prev text;
begin
  for q in
    select id, requester_id, department_id, week_start, status, status_reason from public.requests
    where join_ride_id = new.id and status not in ('cancelled', 'withdrawn', 'denied', 'external')
      and not exists (select 1 from public.ride_requests rr where rr.request_id = requests.id and rr.ride_id = new.id)
    order by id
  loop
    v_prev := coalesce(current_setting('app.system_status_transition', true), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set join_ride_id = null,
      status_reason = case when status_reason in ('ASK_TO_JOIN', 'ASK_TO_JOIN_TEMP_CAR') then null else status_reason end
    where id = q.id;
    perform set_config('app.system_status_transition', v_prev, true);
    perform public.enqueue_notification(q.requester_id, 'outcome_changed', q.department_id, q.week_start,
      '{}'::jsonb, jsonb_build_object('variant', 'join_ride_cancelled', 'request_id', q.id, 'ride_id', new.id),
      format('join_ride_cancelled:%s:%s', q.id, new.id));
  end loop;
  return new;
end $$;

drop trigger if exists rides_release_join_requests on public.rides;
create trigger rides_release_join_requests after update of status on public.rides
  for each row when (new.status = 'cancelled' and old.status is distinct from 'cancelled')
  execute function public.rides_release_join_requests();

-- ---------------------------------------------------------------------------------------------------------
-- R7B14: a flagged ride whose conflict is gone is cleared by whichever write removed the conflict.
create or replace function public.refresh_ride_flags(p_car uuid) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; v_n int := 0; v_clear boolean; v_broken boolean;
begin
  for r in
    select rd.* from public.rides rd
    where rd.car_id = p_car and rd.status = 'flagged' and not rd.needs_driver
      and rd.flag_reason in ('car_chain_broken', 'relay_pair_cancelled', 'relay_driver_missing', 'maintenance')
    order by rd.starts_at, rd.id
  loop
    v_broken := not r.planning_conflict and (not r.auto_relocation or r.driver_id is not null)
      and not public.ride_is_reservation(r.id)
      and public.car_location_excluding(r.car_id, r.starts_at, r.id) is distinct from r.origin_id;
    v_clear := case r.flag_reason
      when 'car_chain_broken' then not v_broken
      when 'relay_pair_cancelled' then not v_broken
      when 'maintenance' then not exists (select 1 from public.car_maintenance_blocks b
        where b.car_id = r.car_id and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(r.starts_at, r.blocked_until, '[)'))
      when 'relay_driver_missing' then not exists (select 1 from public.rides x
        where x.car_id = r.car_id and x.week_start = r.week_start and x.id <> r.id and x.status <> 'cancelled'
          and x.needs_driver and x.ends_at <= r.starts_at)
      else false end;
    if v_clear then
      update public.rides set flag_reason = null, status = 'confirmed' where id = r.id;
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;

create or replace function public.rides_refresh_flags() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.refresh_ride_flags(new.car_id);
  if tg_op = 'UPDATE' and old.car_id is distinct from new.car_id then perform public.refresh_ride_flags(old.car_id); end if;
  return null;
end $$;

drop trigger if exists rides_refresh_flags on public.rides;
create trigger rides_refresh_flags after insert or update of status, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, needs_driver
  on public.rides for each row when (pg_trigger_depth() = 0)
  execute function public.rides_refresh_flags();

create or replace function public.ride_requests_refresh_flags() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_car uuid;
begin
  select car_id into v_car from public.rides where id = coalesce(new.ride_id, old.ride_id);
  if v_car is not null then perform public.refresh_ride_flags(v_car); end if;
  return null;
end $$;

drop trigger if exists ride_requests_refresh_flags on public.ride_requests;
create trigger ride_requests_refresh_flags after insert or delete on public.ride_requests
  for each row when (pg_trigger_depth() = 0)
  execute function public.ride_requests_refresh_flags();

create or replace function public.maintenance_refresh_flags() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.refresh_ride_flags(old.car_id);
  return null;
end $$;

drop trigger if exists maintenance_refresh_flags on public.car_maintenance_blocks;
create trigger maintenance_refresh_flags after update or delete on public.car_maintenance_blocks
  for each row when (pg_trigger_depth() = 0)
  execute function public.maintenance_refresh_flags();

revoke all on function public.rides_release_join_requests() from public, anon, authenticated;
revoke all on function public.refresh_ride_flags(uuid) from public, anon, authenticated;
revoke all on function public.rides_refresh_flags() from public, anon, authenticated;
revoke all on function public.maintenance_refresh_flags() from public, anon, authenticated;
revoke all on function public.ride_requests_refresh_flags() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- Templates (Hebrew lives in seeded data). R7U4: removal says what happens next; the Sadran's own placement has
-- its own variant (edit_ride sends `placed_by_sadran`, not `edit_applied`).
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'outcome_changed', ch, t.variant, t.title, t.body, t.title, t.body
from (values
  ('join_ride_cancelled', 'הנסיעה שביקשת להצטרף אליה בוטלה', '{{route}} · {{day}}. הבקשה שלך נשארה פתוחה וממתינה לשיבוץ — אפשר גם לבקש להצטרף לנסיעה אחרת'),
  ('driver_replaced_you', 'הוחלפת בנהיגה', '{{byName}} שיבצ/ה נהג/ת אחר/ת ({{driverName}}) לנסיעה {{route}} · {{day}}. אינך צריך/ה לנהוג'),
  ('driver_changed_passenger', 'הוחלף/ה הנהג/ת בנסיעה שלך', 'הנהג/ת בנסיעה {{route}} · {{day}} הוא/היא עכשיו {{driverName}}. שאר פרטי הנסיעה לא השתנו'),
  ('edit_waitlisted', 'העריכה נשמרה — הבקשה ממתינה לשיבוץ', '{{route}} · {{day}}. הרכב הקודם שוחרר ועדיין לא נמצא רכב מתאים; תעודכן/י כשיהיה שיבוץ'),
  ('placed_by_sadran', 'הסדרן/ית שיבצ/ה אותך בנסיעה', '{{route}} · {{day}} · {{car}}'),
  ('passenger_removed_request', 'הוסרת מנסיעה', '{{byName}} הסיר/ה אותך מהנסיעה {{route}} ביום {{day}}. הבקשה שלך בוטלה — אפשר להגיש בקשה חדשה')
) as t(variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title, default_body = excluded.default_body;

update public.notification_templates
  set body = '{{byName}} הסיר/ה אותך מהנסיעה {{route}} ביום {{day}}. אם זו טעות, אפשר לבקש להצטרף שוב',
      default_body = '{{byName}} הסיר/ה אותך מהנסיעה {{route}} ביום {{day}}. אם זו טעות, אפשר לבקש להצטרף שוב'
  where event = 'outcome_changed' and variant = 'passenger_removed_you';
