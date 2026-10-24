-- REQ item 150 (a): "car administrator" is a flag on the department membership, combinable with member / sadran.
alter table public.department_members
  add column is_car_admin boolean not null default false;

comment on column public.department_members.is_car_admin is
  'REQ 150 (a): this member administers the department''s shared cars (can_manage_car). Not a role value; cleared when the membership is removed.';

-- is_car_admin(dept): the signed-in, approved user is an active car administrator of the department.
create or replace function public.is_car_admin(_dept uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_approved() and exists (
    select 1 from public.department_members dm
    where dm.department_id = _dept and dm.profile_id = (select auth.uid())
      and dm.removed_at is null and dm.is_car_admin);
$$;
revoke all on function public.is_car_admin(uuid) from public;
grant execute on function public.is_car_admin(uuid) to authenticated, service_role;

-- A removed membership loses the flag (re-adding the member must not silently restore it).
create or replace function public.department_members_clear_car_admin() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.removed_at is not null then new.is_car_admin := false; end if;
  return new;
end;
$$;
revoke all on function public.department_members_clear_car_admin() from public;
grant execute on function public.department_members_clear_car_admin() to service_role;

create trigger department_members_clear_car_admin
  before update of removed_at on public.department_members
  for each row execute function public.department_members_clear_car_admin();

-- Admin members screen: the per-department "מנהל/ת רכבים" switch.
create or replace function public.admin_set_car_admin(p_department_id uuid, p_profile_id uuid, p_is_car_admin boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_is_car_admin is null then raise exception 'invalid_input' using errcode = 'P0001'; end if;
  perform set_config('app.audit_reason', 'admin_set_car_admin', true);
  update public.department_members set is_car_admin = p_is_car_admin
    where department_id = p_department_id and profile_id = p_profile_id and removed_at is null;
  if not found then raise exception 'member_not_found' using errcode = 'P0001'; end if;
end;
$$;
revoke all on function public.admin_set_car_admin(uuid, uuid, boolean) from public;
grant execute on function public.admin_set_car_admin(uuid, uuid, boolean) to authenticated, service_role;
