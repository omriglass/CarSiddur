-- REQ §13.100 (QB14) / §13.101: notices about a ride must name where the ride really goes.
-- rides.destination_id is where the CAR is at ride end (the origin for a round trip), so the
-- notice reads the served request instead (driver-role request first = the base of a merge).
create or replace function public.ride_notice_request(p_ride_id uuid)
returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select rr.request_id from public.ride_requests rr join public.requests q on q.id = rr.request_id
  where rr.ride_id = p_ride_id
  order by (rr.role = 'driver') desc, q.depart_at nulls last, rr.request_id limit 1;
$$;

create or replace function public.ride_notice_destination(p_ride_id uuid)
returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select coalesce(d.name, q.destination_text) from public.requests q
       left join public.destinations d on d.id = q.destination_id
       where q.id = public.ride_notice_request(p_ride_id)),
    (select d.name from public.rides r join public.destinations d on d.id = r.destination_id where r.id = p_ride_id), '');
$$;

create or replace function public.ride_notice_route(p_ride_id uuid)
returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    public.request_route_label(public.ride_notice_request(p_ride_id)),
    (select public.route_label(r.department_id, r.origin_id, null, r.destination_id, null) from public.rides r where r.id = p_ride_id),
    '');
$$;

revoke all on function public.ride_notice_request(uuid) from public, anon;
revoke all on function public.ride_notice_destination(uuid) from public, anon;
revoke all on function public.ride_notice_route(uuid) from public, anon;
