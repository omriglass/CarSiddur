-- O3 (REQ §13.93, ORIGINS_PLAN §3): rides_location_ends()'s "this ride needs no served relay
-- leg" shortcut was `origin = destination = home`; a car may now be based anywhere, so the
-- equivalent, origin-generic test is simply `origin = destination` (a closed loop: `keep`,
-- `chauffeur`, or a plain reservation/maintenance-style hold -- none of those move the car
-- anywhere a relay leg needs to account for). Anything that starts and ends in different
-- places (a relay leg) still needs at least one served ride_requests row, exactly as before.
-- Full create-or-replace (hard rule 8).
create or replace function public.rides_location_ends() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.rides%rowtype;
begin
  -- Deferred trigger: `new` is the row image of the *triggering* statement. Re-read the
  -- current row so a ride inserted and then cancelled/edited before the check point is judged
  -- by what it is now (one transaction with several ride writes — a test suite, a batch RPC).
  select * into r from public.rides where id = new.id;
  if not found then return null; end if;
  -- An automatic relocation moves the car between two places and serves nobody; a cancelled
  -- ride has no location semantics at all.
  if r.auto_relocation or r.status = 'cancelled' then
    return null;
  end if;
  if r.origin_id = r.destination_id then
    return null;
  end if;
  if not exists (select 1 from public.ride_requests rr where rr.ride_id = r.id) then
    raise exception 'ride_location_ends_invalid' using errcode = 'P0001',
      detail = 'a ride whose origin differs from its destination must have at least one served relay leg';
  end if;
  return null;
end;
$$;
