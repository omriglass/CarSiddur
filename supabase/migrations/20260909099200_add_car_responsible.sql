-- Car care portal: `cars.responsible_id` (admin-set) is the recipient of car-care
-- notifications and gets full edit rights on their car (REQ §6 car care; owner decision
-- 2026-09-09: "car admin" = regular admin for now, no separate department-scoped admin
-- role exists — `profiles.is_admin` is global, DATA_MODEL.md §2 notes on `role`).
-- DATA_MODEL.md §3.2, §4.2, §4.3.

alter table public.cars add column responsible_id uuid references public.profiles(id) on delete set null;
create index cars_responsible_idx on public.cars (responsible_id) where responsible_id is not null;

-- Is the caller the responsible person of this specific car? Self-referencing lookup on
-- `cars` (verified empirically: a SECURITY DEFINER function re-querying the same row a
-- policy is being evaluated against sees the pre-statement value both in USING and WITH
-- CHECK, so the current responsible person may reassign responsibility away in the same
-- UPDATE — matches DATA_MODEL.md §4.2 helper conventions).
create or replace function public.is_car_responsible(_car_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_approved() and exists (
    select 1 from public.cars c where c.id = _car_id and c.responsible_id = (select auth.uid()));
$$;

-- Recipients of car-care notifications for a car: its responsible person if set,
-- else every approved global admin (REQ §6 car care decision: fallback to admins).
create or replace function public.car_care_recipients(_car_id uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select c.responsible_id from public.cars c
  where c.id = _car_id and c.responsible_id is not null
  union all
  select p.id from public.cars c
  join public.profiles p on p.is_admin and p.approval_status = 'approved'
  where c.id = _car_id and c.responsible_id is null;
$$;

revoke execute on function public.is_car_responsible(uuid) from public, anon;
revoke execute on function public.car_care_recipients(uuid) from public, anon;
grant execute on function public.is_car_responsible(uuid) to authenticated;
grant execute on function public.car_care_recipients(uuid) to authenticated;

-- Let the responsible person edit every column (incl. owner_id) the same way admin
-- already can; existing CHECK constraints (`cars_temporary_owner_ck`, etc.) still apply.
create or replace function public.cars_protect_owner_editable_fields() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
begin
  if not (public.is_admin() or public.is_car_responsible(old.id)) then
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

create policy "cars_update_responsible" on public.cars for update to authenticated
  using (public.is_car_responsible(id))
  with check (public.is_car_responsible(id));
