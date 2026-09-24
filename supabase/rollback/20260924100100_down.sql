-- Down script for supabase/migrations/20260924100100_day_car_swap_rpcs.sql (REQ §13.92).
-- Restores the pre-migration schema: removes the swap RPCs and their internal helpers,
-- puts back the non-deferrable rides_no_overlap_per_car exclusion constraint
-- (20260907102000) and removes the `app.day_car_swap` bypass from rides_before_write().
-- Data is untouched (the migration moved no rows). The car_swapped enum value and its
-- templates (20260924100000/100200) are additive and stay — an unused enum value is harmless.

drop function if exists public.swap_day_cars(uuid, date, date, uuid, uuid, text, text);
drop function if exists public.preview_day_car_swap(uuid, date, date, uuid, uuid);
drop function if exists public._day_car_swap_day_ride_ids(uuid, date, date, uuid, uuid);
drop function if exists public._day_car_swap_series_ids(uuid[]);
drop function if exists public._day_car_swap_expand_whole(uuid[]);
drop function if exists public._day_car_swap_fingerprint(uuid[]);
drop function if exists public._day_car_swap_authorize(uuid, date, date, uuid, uuid, uuid);
drop function if exists public._day_car_swap_private_car_blockers(uuid, uuid, uuid);
drop function if exists public._day_car_swap_physical_blockers(uuid[], uuid, uuid);
drop function if exists public._day_car_swap_notices(uuid[], uuid, uuid, date);
drop function if exists public._day_car_swap_rides_json(uuid[]);
drop function if exists public._day_car_swap_series_json(uuid[]);
drop function if exists public._day_car_swap_split_series(uuid, date);

alter table public.rides drop constraint if exists rides_no_overlap_per_car;
alter table public.rides add constraint rides_no_overlap_per_car
  exclude using gist(car_id with =, tstzrange(starts_at, ends_at, '[)') with &&)
  where (status <> 'cancelled' and not planning_conflict);

do $migration$
declare
  def text;
  new_collision text := $n$select coalesce(current_setting('app.day_car_swap',true),'')<>'on' and exists(select 1 from public.rides r where r.car_id=new.car_id and r.id<>new.id and r.status<>'cancelled'$n$;
  old_collision text := $o$select exists(select 1 from public.rides r where r.car_id=new.car_id and r.id<>new.id and r.status<>'cancelled'$o$;
  new_turn text := $n$if not new.planning_conflict and coalesce(current_setting('app.day_car_swap',true),'')<>'on' and exists(select 1 from public.rides r where r.car_id=new.car_id$n$;
  old_turn text := $o$if not new.planning_conflict and exists(select 1 from public.rides r where r.car_id=new.car_id$o$;
begin
  def := pg_get_functiondef('public.rides_before_write()'::regprocedure);
  def := replace(def, new_collision, old_collision);
  def := replace(def, new_turn, old_turn);
  execute def;
end;
$migration$;
