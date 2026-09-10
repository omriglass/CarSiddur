-- Internal / cron functions carry their own guard (docs/HARDENING_2026-09.md §1.2).
-- Belt and braces for 20260910099000: even if a grant slips back in, a signed-in
-- non-admin session cannot invoke a cron step directly through PostgREST with a
-- caller-supplied clock. PostgREST exposes the top-level call as the transaction-local
-- GUC `request.path` ('/rpc/<name>'); a nested call from another RPC (publish_siddur →
-- expire_proposals) or from pg_cron sees a different path or none, so those keep working.
-- try_auto_approve() now locks the request and only acts on submitted/waitlisted rows.
-- app.tick() isolates each step so one failing step no longer stalls the others.

create or replace function public.assert_not_direct_rpc(p_function text)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
begin
  if current_setting('request.path', true) = '/rpc/' || p_function and not public.is_admin() then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
end;
$function$;
revoke execute on function public.assert_not_direct_rpc(text) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.housekeeping(p_now timestamp with time zone DEFAULT now())
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_hour int; v_last_prune date;
begin
  perform public.assert_not_direct_rpc('housekeeping');
  perform public.expire_freed_offers(p_now);

  v_hour := extract(hour from (p_now at time zone 'Asia/Jerusalem'));
  select (value ->> 'value')::date into v_last_prune from public.app_settings where key = 'housekeeping_last_run';

  if v_last_prune is null or v_last_prune < (p_now at time zone 'Asia/Jerusalem')::date then
    perform public.materialize_templates();

    if v_hour >= 3 then
      delete from public.notifications where created_at < p_now - interval '90 days';
      delete from public.push_outbox where status in ('sent', 'dead') and created_at < p_now - interval '30 days';
      delete from public.client_errors where created_at < p_now - interval '90 days';
      delete from public.push_subscriptions where last_used_at < p_now - interval '180 days';
      -- token_hash cannot be null (unique not-null column); scramble it instead so old links die.
      update public.proposals set token_hash = encode(digest(gen_random_uuid()::text, 'sha256'), 'hex')
      where expires_at < p_now - interval '30 days' and status in ('expired', 'withdrawn', 'applied', 'declined');
      delete from public.audit_log where at < p_now - interval '1 year'
        and table_name not in ('requests', 'rides', 'proposals', 'policies', 'weeks', 'siddur_versions');
      delete from public.audit_log where at < p_now - interval '3 years';
      delete from public.request_templates where not is_active and updated_at < p_now - interval '1 year';

      insert into public.app_settings (key, value, updated_at)
      values ('housekeeping_last_run', to_jsonb((p_now at time zone 'Asia/Jerusalem')::date::text), p_now)
      on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
    end if;
  end if;
end;
$function$

;

CREATE OR REPLACE FUNCTION public.expire_proposals(_now timestamp with time zone DEFAULT now())
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_count int := 0; request_row record; r record; v_today date;
begin
  perform public.assert_not_direct_rpc('expire_proposals');
  v_today := (_now at time zone 'Asia/Jerusalem')::date;
  for request_row in
    select q.id, q.department_id, q.week_start,
      (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date as req_day
    from public.requests q
    where exists(select 1 from public.proposals p where p.request_id = q.id and p.status = 'sent')
    order by q.id for update skip locked
  loop
    if request_row.req_day < v_today
      or public.is_day_public(request_row.department_id, request_row.week_start, request_row.req_day)
    then
      for r in
        update public.proposals set status = 'expired'
        where request_id = request_row.id and status = 'sent'
        returning id, department_id, week_start, request_id, previous_status, created_by
      loop
        v_count := v_count + 1;
        perform public.enqueue_notification(r.created_by, 'proposal_answered', r.department_id, r.week_start,
          '{}'::jsonb, jsonb_build_object('variant', 'expired', 'request_id', r.request_id),
          format('proposal_expired:%s', r.id));
      end loop;
    end if;
  end loop;
  return v_count;
end $function$

;

CREATE OR REPLACE FUNCTION public.expire_freed_offers(_now timestamp with time zone DEFAULT now())
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_count int;
begin
  perform public.assert_not_direct_rpc('expire_freed_offers');
  update public.freed_slot_offers
  set status = 'expired', resolved_at = _now
  where status in ('open','pending_approval') and expires_at <= _now;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$

;

CREATE OR REPLACE FUNCTION public.send_due_reminders(p_now timestamp with time zone DEFAULT now())
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_count int := 0; v_week record; v_settings record; v_hours int;
begin
  perform public.assert_not_direct_rpc('send_due_reminders');
  for v_week in select * from public.weeks where phase = 'open' loop
    select * into v_settings from public.department_settings where department_id = v_week.department_id;
    foreach v_hours in array v_settings.closing_reminder_hours loop
      if p_now >= v_week.close_at - make_interval(hours => v_hours)
         and p_now < v_week.close_at - make_interval(hours => v_hours) + interval '15 min' then
        perform public.enqueue_notification(dm.profile_id, 'window_closing', v_week.department_id, v_week.week_start,
          jsonb_build_object('count', v_hours::text), '{}'::jsonb,
          format('window_closing:%s:%s:%s', v_week.department_id, v_week.week_start, v_hours))
        from public.department_members dm
        where dm.department_id = v_week.department_id and dm.removed_at is null
          and not exists (
            select 1 from public.requests q where q.department_id = v_week.department_id and q.week_start = v_week.week_start
              and q.requester_id = dm.profile_id and q.status <> 'withdrawn'
          );
        v_count := v_count + 1;
      end if;
    end loop;
  end loop;

  for v_week in select * from public.weeks where phase = 'solving' and publish_reminder_sent_at is null loop
    select * into v_settings from public.department_settings where department_id = v_week.department_id;
    if p_now >= ((v_week.week_start - 7 + v_settings.publish_dow)::timestamp + v_settings.publish_time) at time zone 'Asia/Jerusalem' then
      perform public.enqueue_notification(s.profile_id, 'publish_reminder', v_week.department_id, v_week.week_start,
        '{}'::jsonb, '{}'::jsonb, format('publish_reminder:%s:%s', v_week.department_id, v_week.week_start))
      from public.sadranim_of(v_week.department_id, v_week.week_start) as s(profile_id);
      update public.weeks set publish_reminder_sent_at = p_now
      where department_id = v_week.department_id and week_start = v_week.week_start;
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$function$

;

CREATE OR REPLACE FUNCTION public.drain_push_outbox(_now timestamp with time zone DEFAULT now())
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_count int := 0;
  r record;
  v_backoff int[] := array[1,5,15,60];
begin
  perform public.assert_not_direct_rpc('drain_push_outbox');
  for r in
    select id, attempts, created_at from public.push_outbox
    where status in ('pending','failed') and next_attempt_at <= _now
    for update skip locked
  loop
    if r.created_at <= _now - interval '24 hours' then
      update public.push_outbox set status = 'dead' where id = r.id;
      continue;
    end if;
    update public.push_outbox
    set attempts = r.attempts + 1,
        next_attempt_at = _now + make_interval(mins => v_backoff[least(r.attempts + 1, array_length(v_backoff, 1))])
    where id = r.id;
    perform public.dispatch_push_outbox_row(r.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$

;

CREATE OR REPLACE FUNCTION public.dispatch_push_outbox_row(_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_url text; v_secret text;
begin
  perform public.assert_not_direct_rpc('dispatch_push_outbox_row');
  select value ->> 'value' into v_url from public.app_settings where key = 'push_dispatch_url';
  select value ->> 'value' into v_secret from public.app_secrets where key = 'cron_secret';
  if v_url is not null and v_url <> '' then
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', coalesce(v_secret, '')),
      body := jsonb_build_object('outbox_id', _id)
    );
  end if;
end;
$function$

;

CREATE OR REPLACE FUNCTION public.try_auto_approve(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_req record;
  v_car record;
  v_home uuid;
  v_turnaround interval;
  v_ride_id uuid;
  v_preferred_ok boolean := false;
begin
  select * into v_req from public.requests where id = p_request_id for update;
  if v_req.id is null or v_req.status not in ('submitted', 'waitlisted') then
    return null;
  end if;
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
$function$

;

create or replace function app.tick(p_now timestamptz default now())
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_step text;
begin
  foreach v_step in array array['advance_week_phases', 'send_due_reminders', 'expire_proposals', 'drain_push_outbox', 'housekeeping'] loop
    begin
      execute format('select public.%I($1)', v_step) using p_now;
    exception when others then
      raise warning 'app.tick: step % failed: % (%)', v_step, sqlerrm, sqlstate;
      insert into public.app_settings (key, value, updated_at)
      values ('tick_last_error', jsonb_build_object('step', v_step, 'message', sqlerrm, 'sqlstate', sqlstate, 'at', p_now), p_now)
      on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
    end;
  end loop;
end;
$function$;
