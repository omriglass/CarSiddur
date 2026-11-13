-- R19B13 (QA run 19, owner 2026-11-13, REQ item 215): the member who holds a private (loaned) car gets the
-- "רכב פרטי (מושאל)" switch on its car page. The table rules keep `type`/`owner_id` (and the access codes) away
-- from the owner, so the owner's change goes through this function: give the car back to the fleet
-- (p_owner_id null → shared) or hand it to another approved member of the car's department.
create or replace function public.set_own_private_car(p_car_id uuid, p_owner_id uuid default null)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_car public.cars%rowtype;
begin
  select * into v_car from public.cars where id = p_car_id for update;
  if v_car.id is null or v_car.type <> 'temporary' or v_car.owner_id is distinct from (select auth.uid()) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_owner_id is not null and not exists (
      select 1 from public.department_members dm join public.profiles p on p.id = dm.profile_id
      where dm.department_id = v_car.department_id and dm.profile_id = p_owner_id and dm.removed_at is null
        and p.approval_status = 'approved') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- the field guard below lets only this function's own change through
  perform set_config('app.own_private_car', p_car_id::text, true);
  if p_owner_id is null then
    update public.cars set type = 'shared', owner_id = null where id = p_car_id;
  elsif p_owner_id is distinct from v_car.owner_id then
    update public.cars set owner_id = p_owner_id where id = p_car_id;
  end if;
  perform set_config('app.own_private_car', '', true);
end $$;

revoke all on function public.set_own_private_car(uuid, uuid) from public;
grant execute on function public.set_own_private_car(uuid, uuid) to authenticated;

-- The field guard: unchanged, plus the pass for set_own_private_car's own row (type/owner_id only).
create or replace function public.cars_protect_owner_editable_fields()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if nullif(current_setting('app.own_private_car', true), '') = old.id::text
     and (to_jsonb(new) - 'type' - 'owner_id' - 'updated_at') is not distinct from (to_jsonb(old) - 'type' - 'owner_id' - 'updated_at') then
    return new;
  end if;
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
