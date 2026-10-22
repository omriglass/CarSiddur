-- REQ §13.140 (owner 2026-10-22, temporary rule): a ride whose calculated end falls after 23:59 of its start
-- day (a chauffeur ride home from a late pickup, a plan-B or merge that grows the ride) is cut at 23:59 of
-- that day instead of being refused with ride_must_end_same_day — which made the whole apply fail (e.g. the
-- automatic siddur for a day). Only the end moves; the start and everything else stay as written.
--
-- The trigger is named so it fires before every other BEFORE trigger on rides (Postgres fires them by name:
-- "rides_at_day_end" < "rides_before_write" < … < "rides_within_week"), so the overlap, driver-schedule and
-- same-day checks all see the cut end.

create or replace function public.clamp_ride_end_to_day()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_day_end timestamptz;
begin
  if new.starts_at is null or new.ends_at is null or new.status = 'cancelled' then
    return new;
  end if;
  v_day_end := ((new.starts_at at time zone 'Asia/Jerusalem')::date + time '23:59') at time zone 'Asia/Jerusalem';
  if new.ends_at > v_day_end and new.starts_at < v_day_end then
    new.ends_at := v_day_end;
  end if;
  return new;
end $$;

revoke all on function public.clamp_ride_end_to_day() from public;
grant execute on function public.clamp_ride_end_to_day() to service_role;

create trigger rides_at_day_end
  before insert or update of starts_at, ends_at, status on public.rides
  for each row execute function public.clamp_ride_end_to_day();
