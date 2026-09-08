-- REQ §3 / Admin department membership: global admin privileges do not replace membership.
create or replace function public.admin_update_member(p_profile_id uuid, p_details jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare dept uuid := nullif(p_details->>'department_id','')::uuid;
begin
  if not public.is_admin() then raise exception 'not_authorized'; end if;
  if nullif(trim(p_details->>'full_name'), '') is null then raise exception 'invalid_member_name'; end if;
  if dept is not null then
    perform 1 from public.departments where id=dept and is_active for share;
    if not found then raise exception 'not_authorized'; end if;
  end if;
  perform set_config('app.audit_reason', 'admin_update_member', true);
  update public.profiles set full_name=trim(p_details->>'full_name'), phone=nullif(trim(p_details->>'phone'), '')
    where id=p_profile_id;
  if not found then raise exception 'member_not_found'; end if;
  if dept is not null then
    insert into public.department_members(department_id,profile_id,added_by)
      values(dept,p_profile_id,auth.uid())
      on conflict(department_id,profile_id) do update set removed_at=null;
    update public.profiles p set default_department_id=dept where p.id=p_profile_id
      and not exists(select 1 from public.department_members dm join public.departments d on d.id=dm.department_id
        where dm.profile_id=p.id and dm.department_id=p.default_department_id and dm.removed_at is null and d.is_active);
  end if;
end;
$$;
revoke execute on function public.admin_update_member(uuid,jsonb) from public, anon;
grant execute on function public.admin_update_member(uuid,jsonb) to authenticated;
