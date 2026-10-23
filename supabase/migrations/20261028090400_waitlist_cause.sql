-- R13B17 (owner 2026-10-23): a waitlisted member is told the real reason, not always "all cars are busy".
--
-- `waitlist_cause(requests)` is a PostgREST computed field (`select …, waitlist_cause` on `requests`): for a
-- request waiting as `WAITLISTED_NO_CAR` it returns the code that names the blocker right now, the same order
-- as the solver's `noCarReason()` (docs/SOLVER.md §6):
--   WAITLISTED_NO_FITTING_CAR       no active shared car seats them / takes the large luggage at all
--   WAITLISTED_NOT_AT_ORIGIN        no fitting car stands at the request's origin, but one is free elsewhere
--   WAITLISTED_CHILD_SEAT_CARS_BUSY every car with the child seats they need is busy
--   WAITLISTED_SEAT_CARS_BUSY       every car with enough seats is busy
--   WAITLISTED_LARGE_TRUNK_BUSY     every car with a large trunk is busy
-- and null otherwise (the stored reason stands). Read-time, so it follows the week as rides change. Only the
-- request's related people and the week's Sadran get an answer; the row argument is re-read by id.

create or replace function public._car_free_for_request(p_car uuid, p_request uuid, p_at_origin uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  q public.requests%rowtype;
  v_ta interval;
  v_end timestamptz;
begin
  select * into q from public.requests where id = p_request;
  if q.id is null or q.depart_at is null then return false; end if;
  v_ta := make_interval(mins => coalesce(public.required_turnaround_minutes(q.department_id, q.week_start), 30));
  v_end := coalesce(q.return_at, q.depart_at + make_interval(mins => greatest(coalesce(public.request_leg_route_minutes(q.id, 'out'), 60), 15)));
  return (p_at_origin is null or public.car_location_at(p_car, q.depart_at) = p_at_origin)
    and not exists (
      select 1 from public.rides r
      where r.car_id = p_car and r.status <> 'cancelled' and not r.planning_conflict
        and not exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = q.id)
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(q.depart_at, v_end + v_ta, '[)'))
    and not exists (
      select 1 from public.car_maintenance_blocks b
      where b.car_id = p_car and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(q.depart_at, v_end, '[)'));
end $$;

revoke all on function public._car_free_for_request(uuid, uuid, uuid) from public;
grant execute on function public._car_free_for_request(uuid, uuid, uuid) to service_role;

create or replace function public.waitlist_cause(r public.requests)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  q public.requests%rowtype;
  v_origin uuid;
  v_luggage int;
  v_shared int;
  v_seat_ok int;
  v_fitting int;
  v_seat_ids uuid[];
  v_fit_ids uuid[];
begin
  select * into q from public.requests where id = r.id;
  if q.id is null or q.status <> 'waitlisted' or q.status_reason is distinct from 'WAITLISTED_NO_CAR' then return null; end if;
  if not (public.request_related(q.id, (select auth.uid())) or public.can_manage_week(q.department_id, q.week_start)) then
    return null;
  end if;
  v_origin := coalesce(q.origin_id, (select d.home_destination_id from public.departments d where d.id = q.department_id));
  v_luggage := case when q.has_luggage and q.luggage_waived_at is null then 1 else 0 end;

  select array_agg(c.id) filter (where public.car_fits(c.id, q.adults, q.child_seats, q.boosters)),
         array_agg(c.id) filter (where public.car_fits(c.id, q.adults, q.child_seats, q.boosters)
                                   and public.car_takes_luggage(c.id, v_luggage)),
         count(*)
  into v_seat_ids, v_fit_ids, v_shared
  from public.cars c
  where c.department_id = q.department_id and c.status = 'active' and c.type = 'shared';
  v_seat_ok := coalesce(cardinality(v_seat_ids), 0);
  v_fitting := coalesce(cardinality(v_fit_ids), 0);

  if v_fitting = 0 then return 'WAITLISTED_NO_FITTING_CAR'; end if;
  if exists (select 1 from unnest(v_fit_ids) f(id) where public._car_free_for_request(f.id, q.id, v_origin)) then
    return null;
  end if;
  if exists (select 1 from unnest(v_fit_ids) f(id) where public._car_free_for_request(f.id, q.id, null)) then
    return 'WAITLISTED_NOT_AT_ORIGIN';
  end if;
  if v_seat_ok < v_shared then
    return case when q.child_seats + q.boosters > 0 then 'WAITLISTED_CHILD_SEAT_CARS_BUSY' else 'WAITLISTED_SEAT_CARS_BUSY' end;
  end if;
  if v_fitting < v_seat_ok then return 'WAITLISTED_LARGE_TRUNK_BUSY'; end if;
  return null;
end $$;

revoke all on function public.waitlist_cause(public.requests) from public;
grant execute on function public.waitlist_cause(public.requests) to authenticated;
