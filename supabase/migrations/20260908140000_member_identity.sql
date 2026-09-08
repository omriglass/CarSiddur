-- REQ §3 and Member identity and department removal (2026-09-08).
alter table public.profiles add column google_name text not null default '';
alter table public.profiles add column display_name text;
update public.profiles p set
  google_name=coalesce(nullif(trim(u.raw_user_meta_data->>'full_name'),''),nullif(trim(u.raw_user_meta_data->>'name'),''),p.full_name),
  display_name=case when p.full_name is distinct from coalesce(nullif(trim(u.raw_user_meta_data->>'full_name'),''),nullif(trim(u.raw_user_meta_data->>'name'),''),p.full_name)
    then nullif(trim(p.full_name),'') end
from auth.users u where u.id=p.id;

-- full_name remains the effective name for existing views, joins and notifications.
create function public.profiles_effective_name() returns trigger language plpgsql
set search_path=public,pg_temp as $$
begin
  if tg_op='INSERT' then
    new.google_name:=coalesce(nullif(trim(new.google_name),''),new.full_name);
  elsif new.full_name is distinct from old.full_name
    and new.display_name is not distinct from old.display_name
    and new.google_name is not distinct from old.google_name then
    new.display_name:=nullif(trim(new.full_name),'');
  end if;
  new.display_name:=nullif(trim(new.display_name),'');
  new.full_name:=coalesce(new.display_name,new.google_name);
  return new;
end $$;
create trigger profiles_effective_name before insert or update on public.profiles
for each row execute function public.profiles_effective_name();
revoke execute on function public.profiles_effective_name() from public,anon,authenticated;

create function public.sync_google_profile_name() returns trigger language plpgsql security definer
set search_path=public,pg_temp as $$
begin
  update public.profiles set google_name=coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'),''),
    nullif(trim(new.raw_user_meta_data->>'name'),''),google_name) where id=new.id;
  return new;
end $$;
create trigger sync_google_profile_name after update of raw_user_meta_data on auth.users
for each row execute function public.sync_google_profile_name();
revoke execute on function public.sync_google_profile_name() from public,anon,authenticated;

-- Apply cleanup even for legacy admin clients updating removed_at directly.
create function public.cleanup_removed_department_member() returns trigger language plpgsql security definer
set search_path=public,pg_temp as $$
begin
  if old.removed_at is null and new.removed_at is not null then
    delete from public.sadran_assignments where department_id=new.department_id and profile_id=new.profile_id
      and (week_start is null or week_start >= ((now() at time zone 'Asia/Jerusalem')::date-extract(dow from now() at time zone 'Asia/Jerusalem')::int));
    update public.profiles p set default_department_id=(
      select dm.department_id from public.department_members dm join public.departments d on d.id=dm.department_id
      where dm.profile_id=new.profile_id and dm.removed_at is null and d.is_active
      order by dm.created_at,dm.department_id limit 1)
    where p.id=new.profile_id and p.default_department_id=new.department_id;
  end if;
  return new;
end $$;
create trigger cleanup_removed_department_member after update of removed_at on public.department_members
for each row execute function public.cleanup_removed_department_member();
revoke execute on function public.cleanup_removed_department_member() from public,anon,authenticated;

create or replace function public.admin_update_member(p_profile_id uuid,p_details jsonb) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare dept uuid:=nullif(p_details->>'department_id','')::uuid;
  removed uuid[]:=array(select value::uuid from jsonb_array_elements_text(coalesce(p_details->'removed_department_ids','[]'::jsonb)));
begin
  if not public.is_admin() then raise exception 'not_authorized'; end if;
  perform 1 from public.profiles where id=p_profile_id for update;
  if not found then raise exception 'member_not_found'; end if;
  if not (p_details ? 'display_name') and nullif(trim(p_details->>'full_name'),'') is null then
    raise exception 'invalid_member_name';
  end if;
  if dept is not null then
    perform 1 from public.departments where id=dept and is_active for share;
    if not found or dept=any(removed) then raise exception 'not_authorized'; end if;
  end if;
  perform set_config('app.audit_reason','admin_update_member',true);
  if p_details ? 'display_name' then
    update public.profiles set display_name=nullif(trim(p_details->>'display_name'),''),
      phone=nullif(trim(p_details->>'phone'),'') where id=p_profile_id;
  else
    update public.profiles set full_name=trim(p_details->>'full_name'),phone=nullif(trim(p_details->>'phone'),'') where id=p_profile_id;
  end if;
  update public.department_members set removed_at=now(),role='member'
    where profile_id=p_profile_id and department_id=any(removed) and removed_at is null;
  if dept is not null then
    insert into public.department_members(department_id,profile_id,added_by)
      values(dept,p_profile_id,auth.uid()) on conflict(department_id,profile_id) do update
      set removed_at=null,role=case when department_members.removed_at is not null then 'member'::public.role else department_members.role end;
  end if;
  update public.profiles p set default_department_id=(
    select dm.department_id from public.department_members dm join public.departments d on d.id=dm.department_id
    where dm.profile_id=p.id and dm.removed_at is null and d.is_active
    order by (dm.department_id=dept) desc,dm.created_at,dm.department_id limit 1)
  where p.id=p_profile_id and not exists(select 1 from public.department_members dm join public.departments d on d.id=dm.department_id
    where dm.profile_id=p.id and dm.department_id=p.default_department_id and dm.removed_at is null and d.is_active);
end $$;
