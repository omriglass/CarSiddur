-- FU1 (owner 2026-11-13, REQ item 217): cars.fuel_type — shown at the top of the car page with the licence plate,
-- on the /my car cards and the /cars overview; diesel cars also take urea (FU2). Null = not set yet.
-- Readable like every other cars column (public: rls_smoke.sql TEST 18).
alter table public.cars add column fuel_type public.car_fuel_type;
