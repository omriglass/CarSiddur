-- REQ item 227 (owner 2026-11-13, TODO PC1): a private car can have several owners.
-- `car_owners` is the truth; `cars.owner_id` stays as a mirror of the first owner (by `created_at`, id) for readers that
-- only need a name or a place (`car_base_location`), and is read by nothing that decides permissions (migration
-- 20261113170200 moves every check to `is_car_owner()`).

create table public.car_owners (
  id uuid primary key default gen_random_uuid(),
  car_id uuid not null references public.cars(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete cascade,
  added_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (car_id, profile_id)
);
create index car_owners_profile_idx on public.car_owners (profile_id);
create index car_owners_department_idx on public.car_owners (department_id);

create trigger set_updated_at before update on public.car_owners
  for each row execute function public.set_updated_at();
create trigger audit_row after insert or update or delete on public.car_owners
  for each row execute function public.audit_row();

alter table public.car_owners enable row level security;
alter table public.car_owners force row level security;
-- Department members see who owns their department's private cars; writes go through add_car_owner / remove_car_owner.
create policy car_owners_select on public.car_owners for select to authenticated
  using ((select public.is_admin()) or department_id in (select d from public.my_department_ids() d));
grant select on public.car_owners to authenticated;

-- (c) the last owner may leave the department: the car stays private with no owner.
alter table public.cars drop constraint cars_temporary_owner_ck;
alter table public.cars add constraint cars_temporary_owner_ck check (type = 'temporary' or owner_id is null);

insert into public.car_owners (car_id, profile_id, department_id, created_at)
select c.id, c.owner_id, c.department_id, c.created_at
from public.cars c
where c.type = 'temporary' and c.owner_id is not null
on conflict (car_id, profile_id) do nothing;

-- ---------------------------------------------------------------------------------------------------------------------
-- Helpers. `is_car_owner` is internal (RPC bodies, triggers); `my_owned_car_ids` is the policies' once-per-query set.
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.is_car_owner(p_car uuid, p_person uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select p_person is not null
    and exists (select 1 from public.car_owners o where o.car_id = p_car and o.profile_id = p_person);
$$;
revoke all on function public.is_car_owner(uuid, uuid) from public;

create or replace function public.car_has_owners(p_car uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.car_owners o where o.car_id = p_car);
$$;
revoke all on function public.car_has_owners(uuid) from public;

create or replace function public.my_owned_car_ids()
returns setof uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select o.car_id from public.car_owners o where o.profile_id = (select auth.uid());
$$;
revoke all on function public.my_owned_car_ids() from public;
grant execute on function public.my_owned_car_ids() to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
-- Mirror: car_owners → cars.owner_id (first owner, or null).
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public._sync_car_owner_id(p_car uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_first uuid;
  v_prev_sync text := coalesce(current_setting('app.car_owner_sync', true), '');
  v_prev_pass text := coalesce(current_setting('app.own_private_car', true), '');
begin
  select o.profile_id into v_first from public.car_owners o where o.car_id = p_car order by o.created_at, o.id limit 1;
  if exists (select 1 from public.cars c where c.id = p_car and c.type = 'temporary' and c.owner_id is distinct from v_first) then
    perform set_config('app.car_owner_sync', 'on', true);
    -- cars_protect_owner_editable_fields lets a change of type/owner_id only through with this pass
    perform set_config('app.own_private_car', p_car::text, true);
    update public.cars set owner_id = v_first where id = p_car;
    perform set_config('app.own_private_car', v_prev_pass, true);
    perform set_config('app.car_owner_sync', v_prev_sync, true);
  end if;
end $$;
revoke all on function public._sync_car_owner_id(uuid) from public;

create or replace function public.car_owners_sync_car()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(current_setting('app.car_owner_sync', true), '') = 'on' then return null; end if;
  perform public._sync_car_owner_id(coalesce(new.car_id, old.car_id));
  return null;
end $$;
revoke all on function public.car_owners_sync_car() from public;

create trigger car_owners_sync_car after insert or delete on public.car_owners
  for each row execute function public.car_owners_sync_car();

-- An explicit change of cars.type / cars.owner_id (the admin/Sadran/responsible person's "רכב פרטי" switch, the car
-- form, a member registering their own car) sets the owner list: shared = no owners; a new owner_id = just that person.
create or replace function public.cars_sync_owners()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_prev text := coalesce(current_setting('app.car_owner_sync', true), '');
begin
  if v_prev = 'on' then return null; end if;
  if tg_op = 'UPDATE' and new.type is not distinct from old.type and new.owner_id is not distinct from old.owner_id then
    return null;
  end if;
  perform set_config('app.car_owner_sync', 'on', true);
  if new.type <> 'temporary' or new.owner_id is null then
    delete from public.car_owners where car_id = new.id;
  elsif tg_op = 'INSERT' or old.type is distinct from 'temporary' or old.owner_id is distinct from new.owner_id then
    delete from public.car_owners where car_id = new.id and profile_id <> new.owner_id;
    insert into public.car_owners (car_id, profile_id, department_id, added_by)
    values (new.id, new.owner_id, new.department_id, (select auth.uid()))
    on conflict (car_id, profile_id) do nothing;
  end if;
  perform set_config('app.car_owner_sync', v_prev, true);
  return null;
end $$;
revoke all on function public.cars_sync_owners() from public;

create trigger cars_sync_owners after insert or update of type, owner_id on public.cars
  for each row execute function public.cars_sync_owners();

-- (c) A member who leaves the department stops owning its cars (the last owner leaving leaves the car ownerless).
create or replace function public.department_member_left_car_owners()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' or (old.removed_at is null and new.removed_at is not null) then
    delete from public.car_owners o
    where o.profile_id = old.profile_id and o.department_id = old.department_id;
  end if;
  return null;
end $$;
revoke all on function public.department_member_left_car_owners() from public;

create trigger department_member_left_car_owners after update of removed_at or delete on public.department_members
  for each row execute function public.department_member_left_car_owners();

-- ---------------------------------------------------------------------------------------------------------------------
-- RPCs (REQ item 227 b): any owner, the department's Sadran or an admin adds/removes; never the last owner.
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.add_car_owner(p_car_id uuid, p_profile_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := (select auth.uid());
  v_car public.cars%rowtype;
  v_id uuid;
begin
  select * into v_car from public.cars where id = p_car_id for update;
  if v_car.id is null or v_car.type <> 'temporary' then raise exception 'not_authorized' using errcode = '42501'; end if;
  if not (public.is_car_owner(p_car_id, v_actor) or public.can_manage_operations(v_car.department_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not exists (
      select 1 from public.department_members dm join public.profiles p on p.id = dm.profile_id
      where dm.department_id = v_car.department_id and dm.profile_id = p_profile_id and dm.removed_at is null
        and p.approval_status = 'approved') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  insert into public.car_owners (car_id, profile_id, department_id, added_by)
  values (p_car_id, p_profile_id, v_car.department_id, v_actor)
  on conflict (car_id, profile_id) do nothing
  returning id into v_id;
  if v_id is not null and p_profile_id is distinct from v_actor then
    perform public.enqueue_notification(p_profile_id, 'private_car_changed', v_car.department_id, null,
      jsonb_build_object('carName', v_car.name,
        'byName', coalesce((select full_name from public.profiles where id = v_actor), '')),
      jsonb_build_object('variant', 'owner_added', 'car_id', p_car_id),
      format('car_owner_added:%s:%s', p_car_id, p_profile_id));
  end if;
end $$;
revoke all on function public.add_car_owner(uuid, uuid) from public;
grant execute on function public.add_car_owner(uuid, uuid) to authenticated;

create or replace function public.remove_car_owner(p_car_id uuid, p_profile_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := (select auth.uid());
  v_car public.cars%rowtype;
begin
  select * into v_car from public.cars where id = p_car_id for update;
  if v_car.id is null or v_car.type <> 'temporary' then raise exception 'not_authorized' using errcode = '42501'; end if;
  if not (public.is_car_owner(p_car_id, v_actor) or public.can_manage_operations(v_car.department_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not public.is_car_owner(p_car_id, p_profile_id) then return; end if;
  if not exists (select 1 from public.car_owners o where o.car_id = p_car_id and o.profile_id <> p_profile_id) then
    raise exception 'car_last_owner' using errcode = 'P0001';
  end if;
  delete from public.car_owners where car_id = p_car_id and profile_id = p_profile_id;
end $$;
revoke all on function public.remove_car_owner(uuid, uuid) from public;
grant execute on function public.remove_car_owner(uuid, uuid) to authenticated;
