-- Fix (stage 1c follow-up, DATA_MODEL.md §6.1 item 13): `v_my_requests` (20260907091700_views.sql)
-- already has `with (security_invoker = true)`, so RLS of `requests` does apply per query — but
-- the view exposed no `requester_id` column, so calling code had no way to add an explicit
-- `.eq('requester_id', session.user.id)` filter. Without it, anyone whose `requests_select`
-- visibility is broader than "my own" (a Sadran or admin, or any approved member reading a
-- published cross-department siddur via the `request_served_by_public_ride()` clause) gets rows
-- belonging to other members back from a view named "my requests" if the caller ever queries it
-- unfiltered — exactly what stage 1c flagged as a leak. Adding the column lets the app enforce
-- "mine" explicitly instead of relying on the view's name.
--
-- The other three views in 20260907091700_views.sql were reviewed for the same class of bug:
-- `v_board_rides` and `v_car_locations` are Sadran/admin board views (broad visibility is the
-- intent, not a leak); `v_week_summary` returns department/week/status aggregates only, no
-- per-member row data. None of them need a similar fix.

-- CREATE OR REPLACE VIEW cannot reorder/insert columns, only append at the end; dropping and
-- recreating is simplest here (grants are re-applied below).
drop view public.v_my_requests;

create view public.v_my_requests with (security_invoker = true) as
select
  q.id as request_id, q.requester_id, q.department_id, q.week_start, q.status, q.status_reason, q.is_late, q.changed_since_solve,
  q.depart_at, q.return_at, q.trip_shape, q.one_way_car_mode, q.needs_car_at_destination,
  coalesce(dst.name, q.destination_text) as destination, rt.name_he as ride_type_name,
  r.id as ride_id, r.starts_at, r.ends_at, r.status as ride_status, c.name as car_name, c.license_plate,
  ro.name as ride_origin, re.name as ride_destination, drv.full_name as driver_name,
  rr.role, rr.leg, rr.car_mode,
  pr.id as pending_proposal_id, pr.type as pending_proposal_type, pr.reason_he as pending_proposal_reason, pr.expires_at as pending_proposal_expires_at
from public.requests q
join public.ride_types rt on rt.id = q.ride_type_id
left join public.destinations dst on dst.id = q.destination_id
left join public.ride_requests rr on rr.request_id = q.id
left join public.rides r on r.id = rr.ride_id and r.status <> 'cancelled'
left join public.destinations ro on ro.id = r.origin_id
left join public.destinations re on re.id = r.destination_id
left join public.cars c on c.id = r.car_id
left join public.profiles drv on drv.id = r.driver_id
left join public.proposals pr on pr.request_id = q.id and pr.status = 'sent';

grant select on public.v_my_requests to authenticated;
revoke all on public.v_my_requests from anon;
