-- Read-only views: security_invoker, joins only, RLS of base tables applies.
-- DATA_MODEL.md §7, §6 step 18.

create or replace view public.v_board_rides with (security_invoker = true) as
select
  r.id, r.department_id, r.week_start, r.car_id, r.starts_at, r.ends_at, r.blocked_until,
  r.status, r.is_pinned, r.pin_reason, r.version,
  r.origin_id, o.name as origin_name, r.destination_id, e.name as destination_name,
  r.overflow_allowed, r.overnight_ack_by, r.driver_id, d.full_name as driver_name,
  not exists (select 1 from public.ride_requests x where x.ride_id = r.id and x.role = 'driver') as is_chauffeur,
  coalesce(jsonb_agg(jsonb_build_object(
      'request_id', q.id, 'role', rr.role, 'leg', rr.leg, 'car_mode', rr.car_mode,
      'requester', p.full_name, 'destination', coalesce(dst.name, q.destination_text), 'ride_type', rt.code,
      'adults', q.adults, 'child_seats', q.child_seats, 'boosters', q.boosters, 'luggage', q.has_luggage
    ) order by rr.role, p.full_name) filter (where q.id is not null), '[]') as served
from public.rides r
join public.destinations o on o.id = r.origin_id
join public.destinations e on e.id = r.destination_id
join public.profiles d on d.id = r.driver_id
left join public.ride_requests rr on rr.ride_id = r.id
left join public.requests q on q.id = rr.request_id
left join public.profiles p on p.id = q.requester_id
left join public.ride_types rt on rt.id = q.ride_type_id
left join public.destinations dst on dst.id = q.destination_id
where r.status <> 'cancelled'
group by r.id, o.name, e.name, d.full_name;

create or replace view public.v_my_requests with (security_invoker = true) as
select
  q.id as request_id, q.department_id, q.week_start, q.status, q.status_reason, q.is_late, q.changed_since_solve,
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

create or replace view public.v_week_summary with (security_invoker = true) as
select q.department_id, q.week_start, rt.code as ride_type, q.status, count(*) as request_count
from public.requests q
join public.ride_types rt on rt.id = q.ride_type_id
group by q.department_id, q.week_start, rt.code, q.status;

-- Per car and day, the away windows and the not-home-at-day-end flag for the board badges
-- (DATA_MODEL §7.5, verbatim).
create or replace view public.v_car_locations with (security_invoker = true) as
select r.car_id, r.department_id, r.week_start,
       r.ends_at                                   as away_from,
       n.starts_at                                 as away_until,
       r.destination_id                            as location_id,
       dl.name                                      as location_name,
       r.id                                         as leaving_ride_id,
       r.overnight_ack_by is not null               as overnight_acknowledged
from public.rides r
join public.departments d on d.id = r.department_id
join public.destinations dl on dl.id = r.destination_id
left join lateral (
  select n.starts_at from public.rides n
  where n.car_id = r.car_id and n.status <> 'cancelled' and n.starts_at > r.ends_at
  order by n.starts_at limit 1
) n on true
where r.status <> 'cancelled' and r.destination_id <> d.home_destination_id;

grant select on public.v_board_rides, public.v_my_requests, public.v_week_summary, public.v_car_locations to authenticated;
revoke all on public.v_board_rides, public.v_my_requests, public.v_week_summary, public.v_car_locations from anon;
