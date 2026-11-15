-- Review 2026-11-15 (owner agreed; amends REQ item 235): a guest who moved their own hour anywhere inside the ride's
-- hours stayed in the ride silently — a departure moved to 12:00 on a ride that leaves at 06:30 was stored while the
-- car still left at 06:30, and nobody was told. A host's edit already asks when a guest ends up far from the ride
-- (`time_far`). The same rule now holds here: the changed hour must also be near the time the ride really passes the
-- member's place (their own flexibility, at least 2 hours — `_merge_check`'s tolerance). Further than that the edit
-- goes the ordinary way (a free car at the new hours, else refused with nothing changed). A place with no estimate
-- (free text) is not checked, as in the merge rule. Full definition; only the last two conditions are new.

create or replace function public._guest_edit_stays(
  p_request_id uuid, payload jsonb, p_trip_type public.trip_type, p_trip_shape public.trip_shape, p_needs_car boolean,
  p_one_way_mode public.leg_car_mode, p_origin_id uuid, p_origin_text text, p_depart_at timestamptz, p_return_at timestamptz)
returns boolean
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  e public.requests%rowtype;
begin
  select * into e from public.requests where id = p_request_id;
  if e.id is null or e.status not in ('assigned', 'merged') or e.series_id is not null then return false; end if;

  -- the edit changes nothing but the hours (and how they were entered / their flexibility): the same check as an
  -- unchanged save, with the time fields taken as stored
  if not public._request_save_unchanged(p_request_id,
       payload - array['flex_depart_early', 'flex_depart_late', 'flex_return_early', 'flex_return_late',
                       'depart_anchor', 'arrive_by', 'return_anchor', 'leave_dest_at', 'duration_locked'],
       p_trip_type, p_trip_shape, p_needs_car, p_one_way_mode, p_origin_id, p_origin_text,
       e.depart_at, case when p_trip_shape = 'one_way_to' then e.kept_return_at else e.return_at end, true) then
    return false;
  end if;

  -- a guest on every ride it is on (never its driver), on published rides only, and each hour that changed inside
  -- the ride that carries that leg (an hour left as it was is fine even when the Sadran merged it a little off)
  if not exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                 where rr.request_id = p_request_id and r.status <> 'cancelled') then
    return false;
  end if;
  return not exists (
    select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
    where rr.request_id = p_request_id and r.status <> 'cancelled'
      and (r.status = 'draft' or rr.role = 'driver' or r.driver_id is not distinct from e.requester_id
           or (rr.covers_out and p_depart_at is distinct from e.depart_at
               and not (p_depart_at >= r.starts_at and p_depart_at < r.ends_at))
           or (rr.covers_return and p_return_at is distinct from e.return_at
               and not (p_return_at is not null and p_return_at > r.starts_at and p_return_at <= r.ends_at))
           -- far from when the ride really passes the member's place (the merge rule: their flexibility, at least
           -- 2 hours): the ride would not move, so the new hour would only be a wish nobody acts on
           or (rr.covers_out and p_depart_at is distinct from e.depart_at and exists (
                 select 1 from (select min(t.eta) as eta from public._ride_route(r.id) t
                                where t.leg = 'out' and t.place_id = e.origin_id) x
                 where x.eta is not null and abs(extract(epoch from (p_depart_at - x.eta)))
                       > extract(epoch from greatest(interval '2 hours', e.flex_depart_early, e.flex_depart_late))))
           or (rr.covers_return and p_return_at is distinct from e.return_at and exists (
                 select 1 from (select min(t.eta) as eta from public._ride_route(r.id) t
                                where t.leg = 'return' and t.place_id = e.destination_id) x
                 where x.eta is not null and abs(extract(epoch from (p_return_at - x.eta)))
                       > extract(epoch from greatest(interval '2 hours', e.flex_return_early, e.flex_return_late))))));
end $$;

revoke all on function public._guest_edit_stays(uuid, jsonb, public.trip_type, public.trip_shape, boolean, public.leg_car_mode, uuid, text, timestamptz, timestamptz) from public, anon, authenticated;
