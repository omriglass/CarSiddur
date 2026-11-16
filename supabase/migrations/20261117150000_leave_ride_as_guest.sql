-- The guest's part of unmerging (20261013160000's unmerge_request body after its checks): the guest is on the ride and
-- is not its main request / driver; the ride gives back the driving the guest added; the request, on no other ride,
-- is its own again ('submitted', p_reason). Callers check who may and lock the ride first.
create or replace function public._unmerge_core(p_ride_id uuid, p_request_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_ride public.rides%rowtype;
  v_guest public.requests%rowtype;
  v_base uuid; v_base_return timestamptz; v_base_depart timestamptz;
  v_before int; v_after int; v_delta int; v_b_out int; v_a_out int; v_b_ret int; v_a_ret int;
  v_start timestamptz; v_end timestamptz; v_prev_sys text; v_new_window boolean;
begin
  select * into v_ride from public.rides where id = p_ride_id;
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
    update public.requests set status = 'submitted', status_reason = p_reason where id = p_request_id;
    perform set_config('app.system_status_transition', v_prev_sys, true);
  end if;

end;
$$;

create or replace function public.unmerge_request(p_ride_id uuid, p_request_id uuid, p_expected_version integer) returns void
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

  perform public._unmerge_core(p_ride_id, p_request_id, 'UNMERGED_BY_SADRAN');
  select * into v_guest from public.requests q where q.id = p_request_id;

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

-- REQ item 246 h (LT1 phase 2d): "לצאת מהנסיעה" - a guest (their request merged into someone else's ride, one way or both)
-- leaves with one tap: the request is its own again, a free car is tried at once (try_auto_approve: placed, or the
-- waiting list on a published day), and the people still on the ride - the driver included - hear it once
-- (`passenger_left`, merged with other unread leaves). Who: the request's related people (request_related).
create or replace function public.leave_ride_as_guest(p_ride_id uuid, p_request_id uuid, p_expected_version integer)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_ride public.rides%rowtype;
  v_actor uuid := (select auth.uid());
  v_res jsonb; v_leaver uuid; v_name text;
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
  return coalesce(v_res, '{}'::jsonb) || jsonb_build_object('request_status', (select q.status from public.requests q where q.id = p_request_id));
end;
$$;

revoke all on function public._unmerge_core(uuid, uuid, text) from public;
revoke all on function public.leave_ride_as_guest(uuid, uuid, integer) from public;
grant execute on function public.leave_ride_as_guest(uuid, uuid, integer) to authenticated;
