-- A member's default origin per department membership (REQ §13.93, ORIGINS_PLAN §2 item 3).
-- `department_members` is department-scoped, not cross-department-readable, so no
-- rls_smoke.sql TEST 18 pin is needed. `department_members_update` (20260907091400_rls.sql)
-- is admin-only, so a member needs this SECURITY DEFINER RPC to set their own default origin;
-- an admin may still update the column directly through the existing admin-only policy.
alter table public.department_members
  add column default_origin_id uuid;

alter table public.department_members
  add constraint department_members_default_origin_id_fkey foreign key (department_id, default_origin_id)
    references public.destinations (department_id, id);

create or replace function public.set_my_default_origin(p_department_id uuid, p_origin_id uuid) returns void
security definer set search_path = public, pg_temp language plpgsql as $$
begin
  if not public.member_of(p_department_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_origin_id is not null and not exists (
    select 1 from public.destinations d where d.id = p_origin_id and d.department_id = p_department_id and d.is_approved
  ) then
    raise exception 'invalid_origin' using errcode = 'P0001';
  end if;
  update public.department_members
    set default_origin_id = p_origin_id
    where department_id = p_department_id and profile_id = (select auth.uid()) and removed_at is null;
  if not found then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
end;
$$;

revoke execute on function public.set_my_default_origin(uuid, uuid) from public, anon;
grant execute on function public.set_my_default_origin(uuid, uuid) to authenticated;
