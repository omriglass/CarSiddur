-- REQ §13.94 (BOARD_DRAFTS_PLAN §2) "Unmerge by dragging the added person out": unmerge_request().
-- Sadran (can_manage_week) only. Removes the guest's ride_requests rows from the ride, shrinks the host
-- window by the driving the guest added (route minutes before minus after, rounded up to a quarter
-- hour; never below the base request's own return time, never past the old end), sets the guest's
-- request back to `submitted` (unmet) when no other live ride covers it (app.system_status_transition
-- convention, caller's value restored), bumps the ride version, and tells the guest with the existing
-- `outcome_changed` / `passenger_removed_you` template. Refuses the base (driver) request
-- (`unmerge_base_request`) and a request that is not on the ride (`request_not_on_ride`). Published
-- rides follow unassign_ride / remove_ride_person: the Sadran may edit them (no extra public-day refusal).
create or replace function public.unmerge_request(p_ride_id uuid, p_request_id uuid, p_expected_version int)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_ride public.rides%rowtype;
  v_actor uuid := (select auth.uid());
  v_guest public.requests%rowtype;
  v_base uuid; v_base_return timestamptz;
  v_before int; v_after int; v_delta int;
  v_end timestamptz; v_prev_sys text;
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
  v_before := public.ride_route_minutes(p_ride_id, 'both');
  delete from public.ride_requests where ride_id = p_ride_id and request_id = p_request_id;
  v_after := public.ride_route_minutes(p_ride_id, 'both');
  v_delta := greatest(coalesce(v_before, 0) - coalesce(v_after, 0), 0);

  v_end := v_ride.ends_at;
  if v_delta > 0 then
    -- 23:59 is the capped "end of day": treat it as 24:00 so the quarter-hour arithmetic inverts apply.
    if (v_end at time zone 'Asia/Jerusalem')::time = time '23:59' then v_end := v_end + interval '1 minute'; end if;
    v_end := v_end - make_interval(mins => (ceil(v_delta / 15.0) * 15)::int);
    select case when rr2.covers_return then q.return_at end into v_base_return
    from public.ride_requests rr2 join public.requests q on q.id = rr2.request_id
    where rr2.ride_id = p_ride_id and rr2.request_id = v_base limit 1;
    v_end := greatest(v_end, coalesce(v_base_return, v_end), v_ride.starts_at + interval '15 minutes');
    v_end := least(public._round_up_ride_end(v_ride.starts_at, v_end), v_ride.ends_at);
  end if;

  update public.rides set ends_at = v_end, updated_at = now() where id = p_ride_id;
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
revoke all on function public.unmerge_request(uuid, uuid, int) from public;
grant execute on function public.unmerge_request(uuid, uuid, int) to authenticated;
