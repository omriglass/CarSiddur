-- withdraw_request() left the ride booked (docs/HARDENING_2026-09.md §2.1).
-- Non-series branch: draft rides from planning are released (release_request_draft_rides,
-- REQ §5.2 "any non-final state → withdrawn"); a request already on a confirmed/flagged
-- ride raises request_has_ride — after publication the member cancels the ride instead
-- (REQ §5.2 "cancelled (by member after publish, frees the ride)"), which the UI already
-- offers. The row is locked and a null expected_version is rejected like everywhere else.

create or replace function public.withdraw_request(p_request_id uuid, p_expected_version integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare v_req record;
begin
  select * into v_req from public.requests where id = p_request_id for update;
  if v_req is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if v_req.requester_id <> (select auth.uid()) and not public.can_manage_week(v_req.department_id, v_req.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_expected_version is null or v_req.version <> p_expected_version then perform public.raise_stale_version(); end if;
  perform set_config('app.audit_reason', 'withdraw_request', true);
  if v_req.series_id is null then
    if exists (
      select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
      where rr.request_id = p_request_id and r.status in ('confirmed', 'flagged')
    ) then
      raise exception 'request_has_ride' using errcode = 'P0001';
    end if;
    perform public.release_request_draft_rides(p_request_id);
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
end $function$;
