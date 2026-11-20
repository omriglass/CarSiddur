-- Saving a request whose place was typed (not from the list) suggests that place to the admin. The second save of the
-- same request (any edit, e.g. after "לכתוב במילים") hit destinations_department_name_key and showed "ערך כזה כבר
-- קיים" although the request itself was saved. A name already in the department's list (suggested or approved) now
-- returns the existing row's id.
create or replace function public.suggest_destination(p_department_id uuid, p_name text, p_zone text default 'unknown')
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  if not (public.is_admin() or public.member_of(p_department_id)) then raise exception 'not_authorized' using errcode='P0001'; end if;
  if nullif(trim(p_name),'') is null then raise exception 'invalid_destination_name' using errcode='P0001'; end if;
  insert into public.destinations(department_id,name,zone,is_approved,created_by)
  values(p_department_id,p_name,p_zone,false,(select auth.uid()))
  on conflict (department_id,name) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.destinations where department_id = p_department_id and name = p_name;
  end if;
  return v_id;
end $$;
