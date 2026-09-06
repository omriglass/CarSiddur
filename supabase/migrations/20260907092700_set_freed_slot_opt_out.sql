-- Stage 3 hardening fix #3 (DATA_MODEL.md §6.1 item 18): a dedicated RPC so the requester
-- (or the Sadran of the week) can flip `requests.freed_slot_opt_out` on an *existing*
-- request without going through `submit_request()` — whose update branch does not
-- coalesce every column, so calling it with only this one field would null out
-- destination/ride-type/timing data (UX_FLOWS.md §14 item 3's recorded blocker). Wires the
-- previously UI-only checkbox on `/p/:token` (deny/external variant) and the "My requests"
-- list.
create or replace function public.set_freed_slot_opt_out(p_request_id uuid, p_opt_out boolean) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
declare v_req record;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if v_req.requester_id <> (select auth.uid()) and not public.can_manage_week(v_req.department_id, v_req.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'set_freed_slot_opt_out', true);
  update public.requests set freed_slot_opt_out = p_opt_out where id = p_request_id;
end;
$$;

revoke execute on function public.set_freed_slot_opt_out(uuid, boolean) from public, anon;
grant execute on function public.set_freed_slot_opt_out(uuid, boolean) to authenticated;
