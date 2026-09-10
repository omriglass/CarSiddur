-- REQ §13.77 — cancelling or withdrawing one day of a multi-day booking ends the booking.
--
-- A series is one reservation the member made; there is no such thing as "keep Monday and
-- Tuesday but drop Wednesday" in v1 (that is cancel + resubmit). Both entry points
-- therefore cascade over `series_id`, and the member is told once: the leg the actor acted
-- on goes through the ordinary path (which sends the notification), the remaining legs are
-- released quietly, so a 5-day booking produces one notice, not five.

create or replace function public.withdraw_request(p_request_id uuid, p_expected_version integer)
returns void security definer set search_path = public, pg_temp language plpgsql as $$
declare v_req record;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if v_req.requester_id <> (select auth.uid()) and not public.can_manage_week(v_req.department_id, v_req.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if v_req.version <> p_expected_version then perform public.raise_stale_version(); end if;

  perform set_config('app.audit_reason', 'withdraw_request', true);
  if v_req.series_id is null then
    update public.requests set status = 'withdrawn', status_reason = 'WITHDRAWN_BY_MEMBER' where id = p_request_id;
    return;
  end if;

  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'withdrawn', status_reason = 'WITHDRAWN_BY_MEMBER'
  where series_id = v_req.series_id and status not in ('withdrawn', 'cancelled');
  update public.rides set status = 'cancelled', cancelled_at = now(),
    cancelled_by = coalesce((select auth.uid()), driver_id, created_by), cancel_reason = 'SERIES_WITHDRAWN'
  where series_id = v_req.series_id and status <> 'cancelled';
  perform set_config('app.system_status_transition', 'off', true);
end $$;

revoke execute on function public.withdraw_request(uuid, integer) from public, anon;
grant execute on function public.withdraw_request(uuid, integer) to authenticated;

alter function public.cancel_ride(uuid, text, integer) rename to cancel_ride_before_series;
revoke execute on function public.cancel_ride_before_series(uuid, text, integer) from public, anon, authenticated;

create function public.cancel_ride(p_ride_id uuid, p_reason text, p_expected_version integer default null)
returns void security definer set search_path = public, pg_temp language plpgsql as $$
declare v_series uuid;
begin
  select series_id into v_series from public.rides where id = p_ride_id;
  perform public.cancel_ride_before_series(p_ride_id, p_reason, p_expected_version);
  if v_series is null then return; end if;
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

revoke execute on function public.cancel_ride(uuid, text, integer) from public, anon;
grant execute on function public.cancel_ride(uuid, text, integer) to authenticated;
