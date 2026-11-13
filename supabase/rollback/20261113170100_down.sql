-- Down for 20261113170100_car_owners.sql (PC1, REQ item 227): restores "a private car has exactly one owner".
-- NOT VALID: an ownerless private car left meanwhile stays; new writes are checked. `car_owners` and its triggers are
-- dropped; `cars.owner_id` (kept as the first owner throughout) is again the only owner. Run after the down of
-- 20261113170200 / …170300 (or with their functions redefined), since those read `car_owners`.
drop trigger if exists department_member_left_car_owners on public.department_members;
drop trigger if exists cars_sync_owners on public.cars;
drop table if exists public.car_owners;
drop function if exists public.department_member_left_car_owners();
drop function if exists public.cars_sync_owners();
drop function if exists public.car_owners_sync_car();
drop function if exists public._sync_car_owner_id(uuid);
drop function if exists public.add_car_owner(uuid, uuid);
drop function if exists public.remove_car_owner(uuid, uuid);
alter table public.cars drop constraint cars_temporary_owner_ck;
alter table public.cars add constraint cars_temporary_owner_ck
  check ((type = 'temporary') = (owner_id is not null)) not valid;
