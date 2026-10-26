-- R15M2 (owner 2026-10-27, QA run 15): a ride cancelled on the board in a LIVE week notifies its people at once
-- instead of waiting for "שלח את כל ההצעות" (REQ §13.138 c keeps holding every other board change). cancel_ride sets
-- the transaction-local flag `app.notify_now` for a live week; _board_hold_applies never holds while it is on.
-- Full definitions from schema-current.sql.

create or replace function public._board_hold_applies("_recipient" "uuid", "_event" "public"."notification_event", "_department_id" "uuid", "_week_start" "date") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_headers text := nullif(current_setting('request.headers', true), '');
  v_actor uuid := (select auth.uid());
  v_surface text;
begin
  if v_headers is null or v_actor is null or _recipient is null or _department_id is null or _week_start is null then
    return false;
  end if;
  if coalesce(current_setting('app.flushing_held_notices', true), '') = 'on'
     or coalesce(current_setting('app.publishing', true), '') = 'on'
     or coalesce(current_setting('app.notify_now', true), '') = 'on' then   -- R15M2: a live-week cancellation
    return false;
  end if;
  if _event not in ('outcome_changed', 'car_swapped', 'waitlist_resolved') or _recipient = v_actor then
    return false;
  end if;
  begin
    v_surface := v_headers::json ->> 'x-app-surface';
  exception when others then
    return false;
  end;
  if v_surface is distinct from 'board' or not public.can_manage_week(_department_id, _week_start) then
    return false;
  end if;
  return not exists (select 1 from public.sadranim_of(_department_id, _week_start) s where s = _recipient);
end $$;

create or replace function public.cancel_ride("p_ride_id" "uuid", "p_reason" "text", "p_expected_version" integer DEFAULT NULL::integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_series uuid; v_req uuid; v_reqs uuid[];
  v_prev_notify text := coalesce(nullif(current_setting('app.notify_now', true), ''), 'off');
begin
  select series_id into v_series from public.rides where id = p_ride_id;
  -- R15M2 (owner 2026-10-27): in a live week a cancellation reaches the people on the ride at once, even when made on
  -- the board (other board changes are still held for "שלח את כל ההצעות", REQ §13.138).
  if exists (select 1 from public.rides r join public.weeks w on w.department_id = r.department_id and w.week_start = r.week_start
             where r.id = p_ride_id and w.phase = 'live') then
    perform set_config('app.notify_now', 'on', true);
  end if;
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
    perform set_config('app.notify_now', v_prev_notify, true);
    return;
  end if;
  -- A passenger removing only their own seat does not cancel the ride, and must not
  -- cancel the series either.
  if not exists (select 1 from public.rides where id = p_ride_id and status = 'cancelled') then
    perform set_config('app.notify_now', v_prev_notify, true);
    return;
  end if;

  perform set_config('app.audit_reason', coalesce(p_reason, 'series_cancelled'), true);
  perform set_config('app.system_status_transition', 'on', true);
  update public.rides set status = 'cancelled', cancelled_at = now(),
    cancelled_by = coalesce((select auth.uid()), driver_id, created_by),
    cancel_reason = coalesce(p_reason, 'SERIES_CANCELLED')
  where series_id = v_series and status <> 'cancelled';
  update public.requests set status = 'cancelled', status_reason = 'RIDE_CANCELLED'
  where series_id = v_series and status not in ('cancelled', 'withdrawn');
  perform set_config('app.system_status_transition', 'off', true);
  perform set_config('app.notify_now', v_prev_notify, true);
end $$;
