-- REQ §13.96: a Sadran reservation (ride with no served request, not an auto relocation) is location-neutral:
-- it holds time on a car but is ignored wherever the car's position is derived or checked.
-- Internal helper (no grant to authenticated, hard rule 4); always called from inside another SECURITY DEFINER function.
create or replace function public.ride_is_reservation(p_ride_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.rides r
    where r.id = p_ride_id and r.status <> 'cancelled' and not r.auto_relocation
      and not exists (select 1 from public.ride_requests rr where rr.ride_id = r.id));
$$;

revoke all on function public.ride_is_reservation(uuid) from public;
