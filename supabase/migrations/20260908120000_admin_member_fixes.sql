-- Atomic admin approval, profile edits, and roster replacement. REQ §3.
create or replace function public.admin_update_member(p_profile_id uuid, p_details jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'not_authorized'; end if;
  if nullif(trim(p_details->>'full_name'), '') is null then raise exception 'invalid_member_name'; end if;
  perform set_config('app.audit_reason', 'admin_update_member', true);
  update public.profiles set full_name=trim(p_details->>'full_name'), phone=nullif(trim(p_details->>'phone'), '')
    where id=p_profile_id;
  if not found then raise exception 'member_not_found'; end if;
end;
$$;

create or replace function public.admin_approve_member(p_profile_id uuid, p_department_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'not_authorized'; end if;
  perform set_config('app.audit_reason', 'admin_approve_member', true);
  update public.profiles set approval_status='approved', approved_at=coalesce(approved_at,now()),
    default_department_id=coalesce(default_department_id,p_department_id) where id=p_profile_id;
  if not found then raise exception 'member_not_found'; end if;
  insert into public.department_members(department_id,profile_id,added_by)
    values(p_department_id,p_profile_id,auth.uid())
    on conflict(department_id,profile_id) do update set removed_at=null;
end;
$$;

create or replace function public.admin_set_sadran_assignments(p_department_id uuid, p_profile_ids uuid[], p_week_start date default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'not_authorized'; end if;
  -- One department lock serializes overlapping replacements, including initially empty rosters.
  perform 1 from public.departments where id=p_department_id for update;
  if not found then raise exception 'not_authorized'; end if;
  if p_profile_ids is null or (p_week_start is not null and extract(dow from p_week_start)<>0) then
    raise exception 'invalid_roster';
  end if;
  perform 1 from public.department_members dm join public.profiles p on p.id=dm.profile_id
    where dm.department_id=p_department_id and dm.profile_id=any(p_profile_ids) for update of dm, p;
  if exists(select 1 from unnest(p_profile_ids) selected(id) where not exists(
    select 1 from public.department_members dm join public.profiles p on p.id=dm.profile_id
    where dm.department_id=p_department_id and dm.profile_id=selected.id
      and dm.removed_at is null and p.approval_status='approved'
  )) then raise exception 'not_authorized'; end if;
  perform set_config('app.audit_reason', 'admin_set_sadran_assignments', true);
  update public.department_members set role='sadran'
    where department_id=p_department_id and profile_id=any(p_profile_ids) and role<>'sadran';
  delete from public.sadran_assignments where department_id=p_department_id
    and week_start is not distinct from p_week_start and not(profile_id=any(p_profile_ids));
  insert into public.sadran_assignments(department_id,profile_id,week_start,assigned_by)
    select p_department_id,id,p_week_start,auth.uid() from (select distinct unnest(p_profile_ids) id) selected
    where not exists(select 1 from public.sadran_assignments sa where sa.department_id=p_department_id
      and sa.week_start is not distinct from p_week_start and sa.profile_id=selected.id);
end;
$$;
revoke execute on function public.admin_update_member(uuid,jsonb), public.admin_approve_member(uuid,uuid), public.admin_set_sadran_assignments(uuid,uuid[],date) from public, anon;
grant execute on function public.admin_update_member(uuid,jsonb), public.admin_approve_member(uuid,uuid), public.admin_set_sadran_assignments(uuid,uuid[],date) to authenticated;
