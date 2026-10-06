-- REQ §13.104 (QA run 4 R4B9): a ride without a driver is never `confirmed`. A published ride that needs a driver is `flagged`
-- (flag_reason NEEDS_DRIVER - the state cancel_ride_before_series already uses when a driver leaves); an unpublished one stays `draft`;
-- as soon as a driver is set the flag clears and the ride is `confirmed`. Enforced centrally by a BEFORE trigger so every writer
-- (solver apply, edit_ride, proposals, publish, claim) agrees. Reservations (no driver, needs_driver false, notes) are unaffected.
create or replace function public.rides_driverless_not_confirmed() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'confirmed' and new.needs_driver and new.driver_id is null then
    new.status := 'flagged';
    new.flag_reason := 'NEEDS_DRIVER';
  elsif new.status = 'flagged' and new.flag_reason = 'NEEDS_DRIVER' and new.driver_id is not null and not new.needs_driver then
    new.status := 'confirmed';
    new.flag_reason := null;
  end if;
  return new;
end $$;
revoke all on function public.rides_driverless_not_confirmed() from public;

drop trigger if exists rides_driverless_not_confirmed on public.rides;
create trigger rides_driverless_not_confirmed
  before insert or update of status, needs_driver, driver_id, flag_reason on public.rides
  for each row execute function public.rides_driverless_not_confirmed();

-- Existing rows: bring them in line, one ride at a time (a historical row the window checks no longer accept is left as it is
-- and relabelled by its next write).
select set_config('app.audit_reason', 'driverless_rides_never_confirmed', true);
do $$
declare r record;
begin
  for r in select id from public.rides where status = 'confirmed' and needs_driver and driver_id is null loop
    begin
      update public.rides set status = 'flagged', flag_reason = 'NEEDS_DRIVER' where id = r.id;
    exception when others then null;
    end;
  end loop;
end $$;
