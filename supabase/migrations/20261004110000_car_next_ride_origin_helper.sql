-- O3 (REQ §13.93, ORIGINS_PLAN §3): small internal helper shared by try_auto_approve() and
-- assert_car_chain()'s drop_off healing -- "the car's next ride on this car, at or after a
-- given instant, starts where?" (null when there is none that week or ever after). Internal
-- only (no grant to authenticated, hard rule 4) -- always called from inside another
-- SECURITY DEFINER function. Unclaimed `auto_relocation` placeholders (deprecated, left alone
-- by this step, ORIGINS_PLAN §3) carry no location fact of their own and are skipped, same as
-- `assert_car_chain` already did before this change.
create or replace function public.car_next_ride_origin(_car uuid, _after timestamptz) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select r.origin_id from public.rides r
  where r.car_id = _car and r.status <> 'cancelled' and not r.planning_conflict
    and (not r.auto_relocation or r.driver_id is not null)
    and r.starts_at >= _after
  order by r.starts_at asc limit 1;
$$;
