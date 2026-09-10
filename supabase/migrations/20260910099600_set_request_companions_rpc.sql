-- Companions were written in two browser calls (docs/HARDENING_2026-09.md §2.5): a delete
-- then an insert on request_companions; a failure between them lost the companions.
-- set_request_companions() replaces the set in one transaction (requester or
-- can_manage_week, mirroring set_request_children); the direct write policies go away.
-- The existing row triggers (request_companions_valid, request_companions_not_requester,
-- companions_named_passenger_counts) keep validating each row.

create or replace function public.set_request_companions(p_request_id uuid, p_profile_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare q public.requests%rowtype;
begin
  select * into q from public.requests where id = p_request_id for update;
  if not found then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if q.requester_id <> (select auth.uid()) and not public.can_manage_week(q.department_id, q.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if q.status in ('withdrawn', 'cancelled') then
    raise exception 'request_not_editable' using errcode = 'P0001';
  end if;
  perform set_config('app.audit_reason', 'set_request_companions', true);
  delete from public.request_companions
  where request_id = p_request_id and not (profile_id = any(coalesce(p_profile_ids, '{}'::uuid[])));
  insert into public.request_companions (request_id, profile_id)
  select p_request_id, u.profile_id
  from unnest(coalesce(p_profile_ids, '{}'::uuid[])) as u(profile_id)
  on conflict (request_id, profile_id) do nothing;
end $function$;

revoke execute on function public.set_request_companions(uuid, uuid[]) from public, anon;
grant execute on function public.set_request_companions(uuid, uuid[]) to authenticated;

drop policy if exists request_companions_insert on public.request_companions;
drop policy if exists request_companions_delete on public.request_companions;
