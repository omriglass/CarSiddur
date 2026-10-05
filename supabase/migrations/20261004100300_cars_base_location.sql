-- A shared car's base location, default the department home; a temporary car's base falls
-- back to its owner's default origin (`car_base_location()`, 20261004100500). REQ §13.93,
-- ORIGINS_PLAN §2 item 4. `cars` is readable by every approved member across departments
-- (`cars_select`), so the new column is pinned in rls_smoke.sql TEST 18 as public-across-
-- departments (same classification as every other car field). `cars_insert`/`cars_update`
-- already allow an admin, or a temporary car's owner, to write any non-locked column (the
-- `cars_protect_owner_editable_fields` trigger does not mention this column), so no RLS or
-- trigger change is needed for an owner to set their own car's base location.
alter table public.cars
  add column base_location_id uuid;

alter table public.cars
  add constraint cars_base_location_id_fkey foreign key (department_id, base_location_id)
    references public.destinations (department_id, id);
