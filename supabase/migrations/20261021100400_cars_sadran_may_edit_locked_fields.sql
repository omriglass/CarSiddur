-- Owner 2026-10-08: saving a car as a Sadran failed. The `cars` RLS policies already let
-- `can_manage_operations(department_id)` (admins + the department's permanent Sadranim) update a
-- car, but this trigger only exempted admins and the car's responsible person, so a Sadran changing
-- the name, plate, type or built-in seats got `car_fields_locked`. The department's Sadranim now
-- pass too; moving a car to another department still needs the right to manage that department.
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
alter function public.cars_protect_owner_editable_fields() owner to postgres;
