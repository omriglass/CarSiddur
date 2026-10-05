-- REQ §13.96: a Sadran reservation (ride with no served request, not an auto relocation) is location-neutral:
-- it holds time on a car but is ignored wherever the car's position is derived or checked.
-- rides_location_ends() asserted "a ride whose origin differs from its destination serves a request". A ride with no
-- served request is now by definition a reservation, whose places carry no meaning, so any origin/destination is accepted.
-- The deferred constraint trigger stays attached (a no-op), keeping the migration additive.
create or replace function public.rides_location_ends() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return null;
end;
$$;
