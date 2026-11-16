-- LT1 QA run (seed 3972, R-LT1-M4): after "לצאת מהנסיעה" a request try_auto_approve does not place (a הקפצה is never
-- auto-placed) stayed 'submitted' on a published day, on nobody's list. It now goes to the waiting list there.

create or replace function public.leave_ride_as_guest(p_ride_id uuid, p_request_id uuid, p_expected_version integer) returns jsonb
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ride public.rides%rowtype;
  v_actor uuid := (select auth.uid());
  v_res jsonb; v_leaver uuid; v_name text; v_prev text;
begin
  select * into v_ride from public.rides where id = p_ride_id for update;
  if not found or v_ride.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if not public.member_of(v_ride.department_id) or not public.request_related(p_request_id, v_actor) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_expected_version is null or v_ride.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if exists (select 1 from public.weeks w where w.department_id = v_ride.department_id and w.week_start = v_ride.week_start and w.phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  -- the other people on the ride hear it as a passenger leaving (ride_requests_notify_fellows, merged when unread)
  perform set_config('app.audit_reason', 'passenger_cancelled_own_request', true);
  perform public._unmerge_core(p_ride_id, p_request_id, 'LEFT_SHARED_RIDE');
  perform set_config('app.audit_reason', 'leave_ride_as_guest', true);
  -- and the ride's driver too (that trigger leaves the driver to the caller): one notice, merged the same way
  select q.requester_id, p.full_name into v_leaver, v_name from public.requests q join public.profiles p on p.id = q.requester_id
   where q.id = p_request_id;
  if v_ride.driver_id is not null and v_ride.driver_id is distinct from v_actor and v_ride.driver_id is distinct from v_leaver then
    perform public._notify_rider_left(v_ride.driver_id, p_ride_id, v_name, coalesce(public.request_route_label(p_request_id), ''),
      public.day_date_label(v_ride.starts_at), format('passenger_left:%s:%s:%s', p_ride_id, p_request_id, v_ride.driver_id));
  end if;
  if (select q.status from public.requests q where q.id = p_request_id) = 'submitted' then
    v_res := public.try_auto_approve(p_request_id);
  end if;
  -- QA run seed 3972 (R-LT1-M4): what try_auto_approve does not place (a הקפצה never is) waits on the waiting list on a
  -- published day, like a new request there - not 'submitted' with nobody looking at it
  if (select q.status from public.requests q where q.id = p_request_id) = 'submitted'
     and public.is_day_public(v_ride.department_id, v_ride.week_start, (v_ride.starts_at at time zone 'Asia/Jerusalem')::date) then
    v_prev := coalesce(nullif(current_setting('app.system_status_transition', true), ''), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_NO_CAR' where id = p_request_id;
    perform set_config('app.system_status_transition', v_prev, true);
  end if;
  return coalesce(v_res, '{}'::jsonb) || jsonb_build_object('request_status', (select q.status from public.requests q where q.id = p_request_id));
end;
$$;
