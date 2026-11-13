-- "רכב מועדף" (owner 2026-11-13, REQ item 224): a member's own preferred shared car, per department, set in the
-- profile. A new request starts with it as the request's preferred car (a soft preference the solver ranks first when
-- nothing speaks for another car); the member may change or clear it per request. Not a list, no "avoid" (owner).
alter table public.department_members
  add column preferred_car_id uuid references public.cars(id) on delete set null;

create or replace function public.set_my_preferred_car(p_department_id uuid, p_car_id uuid default null)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if not public.member_of(p_department_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_car_id is not null and not exists (
    select 1 from public.cars c where c.id = p_car_id and c.department_id = p_department_id
      and c.type = 'shared' and c.status <> 'retired'
  ) then
    raise exception 'car_not_found' using errcode = 'P0001';
  end if;
  update public.department_members
    set preferred_car_id = p_car_id
    where department_id = p_department_id and profile_id = (select auth.uid()) and removed_at is null;
  if not found then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.set_my_preferred_car(uuid, uuid) from public;
grant execute on function public.set_my_preferred_car(uuid, uuid) to authenticated;
