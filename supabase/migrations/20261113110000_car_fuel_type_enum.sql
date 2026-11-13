-- FU1 (owner 2026-11-13, REQ item 217): a car's fuel type, one of three.
create type public.car_fuel_type as enum ('gasoline', 'diesel', 'electric');
