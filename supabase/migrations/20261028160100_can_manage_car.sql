-- REQ item 150 (a): one rule for "may manage this car".
--   can_manage_car(car) = admin
--                      OR the car's responsible person
--                      OR (the car is shared AND the user is a car administrator of its department).
-- The Sadran is NOT part of it: what a Sadran may do on cars stays exactly what it was (can_manage_operations
-- in the cars/maintenance policies below and in the protect trigger). Car administrators on PRIVATE
-- (temporary) cars may only change the status (cars_protect_owner_editable_fields).
create or replace function public.can_manage_car(p_car_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_admin() or (public.is_approved() and exists (
    select 1 from public.cars c
    where c.id = p_car_id
      and (c.responsible_id = (select auth.uid())
           or (c.type = 'shared' and public.is_car_admin(c.department_id)))));
$$;
revoke all on function public.can_manage_car(uuid) from public;
grant execute on function public.can_manage_car(uuid) to authenticated, service_role;

-- Maintenance periods: the car's managers join admin / Sadran (was: admin, Sadran, responsible).
create or replace function public._can_edit_car_maintenance(p_car_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.can_manage_car(p_car_id) or exists (
    select 1 from public.cars c
    where c.id = p_car_id
      and public.is_approved()
      and (public.can_manage_operations(c.department_id) or public.is_sadran_any(c.department_id)));
$$;

-- A car administrator may update cars of the department; the trigger limits what (shared: like the responsible
-- person, private: status only).
create policy cars_update_car_admin on public.cars for update to authenticated
  using (public.is_car_admin(department_id))
  with check (public.is_car_admin(department_id));

create or replace function public.cars_protect_owner_editable_fields() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not (
    public.is_admin()
    or public.is_car_responsible(old.id)
    or (public.can_manage_operations(old.department_id)
        and (new.department_id is not distinct from old.department_id
             or public.can_manage_operations(new.department_id)))
  ) then
    if public.is_car_admin(old.department_id) and old.owner_id is distinct from (select auth.uid()) then
      -- Acting as a car administrator only.
      if new.department_id is distinct from old.department_id then
        raise exception 'car_fields_locked' using errcode = 'P0001';
      end if;
      if old.type = 'temporary'
         and (to_jsonb(new) - 'status' - 'retired_at' - 'updated_at')
             is distinct from (to_jsonb(old) - 'status' - 'retired_at' - 'updated_at') then
        raise exception 'car_fields_locked' using errcode = 'P0001';
      end if;
      return new;
    end if;
    if new.name is distinct from old.name
       or new.license_plate is distinct from old.license_plate
       or new.department_id is distinct from old.department_id
       or new.type is distinct from old.type
       or new.owner_id is distinct from old.owner_id
       or new.built_in_child_seats is distinct from old.built_in_child_seats
       or new.built_in_boosters is distinct from old.built_in_boosters
    then
      raise exception 'car_fields_locked' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

-- Car-care notices: the car's responsible person, else the department's car administrators (shared cars),
-- else the admins.
create or replace function public.car_care_recipients(_car_id uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  with car as (select c.id, c.department_id, c.type, c.responsible_id from public.cars c where c.id = _car_id),
  responsible as (
    select responsible_id as id from car where responsible_id is not null),
  car_admins as (
    select dm.profile_id as id from car
    join public.department_members dm on dm.department_id = car.department_id
      and dm.removed_at is null and dm.is_car_admin
    join public.profiles p on p.id = dm.profile_id and p.approval_status = 'approved'
    where car.responsible_id is null and car.type = 'shared'),
  admins as (
    select p.id from car
    join public.profiles p on p.is_admin and p.approval_status = 'approved'
    where car.responsible_id is null and not exists (select 1 from car_admins))
  select id from responsible union all select id from car_admins union all select id from admins;
$$;
