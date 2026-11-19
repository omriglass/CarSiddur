-- CR1 (owner 2026-11-17/19, REQ item 257): two car details.
-- corporation: the car's "תאגיד", free text; the car page suggests the names already used on any car (no list table, owner).
-- tire_pressure_front_psi / tire_pressure_rear_psi: the recommended pressure ("לחץ אוויר רצוי בגלגלים"), shown on the
-- car page and in the tire-fill dialog. Null = not set. Readable like every other cars column (public: rls_smoke.sql TEST 18);
-- written by whoever may edit the car (the cars update policies and cars_protect_owner_editable_fields, unchanged).
alter table public.cars
  add column corporation text,
  add column tire_pressure_front_psi smallint,
  add column tire_pressure_rear_psi smallint,
  add constraint cars_corporation_ck check (corporation is null or length(trim(corporation)) between 1 and 80),
  add constraint cars_tire_pressure_ck check (
    (tire_pressure_front_psi is null or tire_pressure_front_psi between 10 and 99)
    and (tire_pressure_rear_psi is null or tire_pressure_rear_psi between 10 and 99));
