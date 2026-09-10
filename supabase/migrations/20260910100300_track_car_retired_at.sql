-- REQ §13.78 owner follow-up (2026-09-10): "retiring a car must not distort statistics".
-- `cars.retired_at` has existed since 20260907090300_fleet.sql, but nothing ever set it —
-- admin removal only ever updates `status` directly (no dedicated RPC; `cars_update`'s
-- direct-edit policy covers it). department_stats()/compute_week_stats() (next migration)
-- need to know *when* a shared car was retired to tell "existed for part of the reporting
-- range" from "already retired before it started", without ever deleting fleet history
-- (cars are never deleted).
--
-- An explicit value supplied by the caller (e.g. a test fixture backdating a retirement)
-- is respected: the trigger only fills a null `retired_at` on the transition into
-- 'retired', and clears it again if the car is later un-retired (back to active/
-- maintenance) so a subsequent re-retirement gets a fresh timestamp.
create or replace function public.cars_track_retired_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status = 'retired'
     and (tg_op = 'INSERT' or old.status is distinct from 'retired')
     and new.retired_at is null
  then
    new.retired_at := now();
  elsif tg_op = 'UPDATE' and old.status = 'retired' and new.status <> 'retired' then
    new.retired_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists cars_track_retired_at on public.cars;
create trigger cars_track_retired_at
  before insert or update on public.cars
  for each row execute function public.cars_track_retired_at();
