-- Invariant checks for the QA regression (docs/QA_SIMULATION.md section 5), run by
-- scripts/qa/regression.mjs through `psql -v dept=<uuid> -v week=<date>` in the stack's DB container.
-- Read-only against the QA department's week; prints `VIOLATION|code|detail` and `STAT|key|value` lines.
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\pset fieldsep '|'

create temp table qa_viol (code text not null, detail text not null);
-- psql variables are not interpolated inside $$ bodies: hand them over as settings.
select set_config('qa.dept', :'dept', false), set_config('qa.week', :'week', false) \g /dev/null

-- 1. No overlap / turnaround breach on a car (rides.blocked_until is the DB's own turnaround-aware bound).
with ordered as (
  select r.id, r.car_id, r.starts_at, r.origin_id, r.destination_id, r.driver_id, r.needs_driver,
         r.series_id, lag(r.series_id) over w as prev_series,
         lag(r.id) over w as prev_id, lag(r.blocked_until) over w as prev_blocked,
         lag(r.destination_id) over w as prev_dest, lag(r.driver_id) over w as prev_driver, lag(r.needs_driver) over w as prev_needs_driver
  from public.rides r
  where r.department_id = :'dept' and r.week_start = :'week' and r.status <> 'cancelled'
  window w as (partition by r.car_id order by r.starts_at, r.id)
)
insert into qa_viol
select 'CAR_OVERLAP', format('car %s: ride %s starts %s before the previous ride %s is free (%s)',
         (select name from public.cars where id = o.car_id), o.id, o.starts_at, o.prev_id, o.prev_blocked)
from ordered o where o.prev_id is not null and o.starts_at < o.prev_blocked
  -- consecutive days of one multi-day series hold the same car: the 23:59 leg's turnaround runs into the next leg by design
  and (o.series_id is null or o.series_id is distinct from o.prev_series);

-- 2. Location chain: a ride must start where the car is. A mismatch is allowed only next to a
--    reservation (a ride with neither a driver nor a missing-driver flag: the Sadran's "save the time").
with ordered as (
  select r.id, r.car_id, r.starts_at, r.origin_id, r.destination_id, r.driver_id, r.needs_driver,
         lag(r.id) over w as prev_id, lag(r.destination_id) over w as prev_dest,
         lag(r.driver_id) over w as prev_driver, lag(r.needs_driver) over w as prev_needs_driver
  from public.rides r
  where r.department_id = :'dept' and r.week_start = :'week' and r.status <> 'cancelled'
  window w as (partition by r.car_id order by r.starts_at, r.id)
)
insert into qa_viol
select 'CHAIN_BREAK', format('car %s: ride %s starts at %s but the previous ride %s left the car at %s',
         (select name from public.cars where id = o.car_id), o.id,
         (select name from public.destinations where id = o.origin_id), o.prev_id,
         (select name from public.destinations where id = o.prev_dest))
from ordered o
where o.prev_id is not null and o.origin_id <> o.prev_dest
  and not (o.driver_id is null and not o.needs_driver)
  and not (o.prev_driver is null and not o.prev_needs_driver);

with firsts as (
  select distinct on (r.car_id) r.id, r.car_id, r.origin_id, r.driver_id, r.needs_driver
  from public.rides r
  where r.department_id = :'dept' and r.week_start = :'week' and r.status <> 'cancelled'
  order by r.car_id, r.starts_at, r.id
)
insert into qa_viol
select 'CHAIN_START', format('car %s: first ride %s starts at %s but the car is at %s', (select name from public.cars where id = f.car_id),
         f.id, (select name from public.destinations where id = f.origin_id), (select name from public.destinations where id = public.car_base_location(f.car_id)))
from firsts f
where f.origin_id <> public.car_base_location(f.car_id) and not (f.driver_id is null and not f.needs_driver);

-- 3. Seats fit, driver rules and request-day rules: the DB's own asserts, one ride at a time.
do $$
declare r record;
begin
  for r in select id from public.rides where department_id = current_setting('qa.dept')::uuid and week_start = current_setting('qa.week')::date and status <> 'cancelled' order by id loop
    begin perform public.assert_ride_seats_fit(r.id);
    exception when others then insert into qa_viol values ('SEATS_DONT_FIT', format('ride %s: %s', r.id, sqlerrm)); end;
    begin perform public.assert_ride_driver(r.id);
    exception when others then insert into qa_viol values ('DRIVER_RULE', format('ride %s: %s', r.id, sqlerrm)); end;
    begin perform public.assert_ride_request_day(r.id);
    exception when others then insert into qa_viol values ('REQUEST_DAY', format('ride %s: %s', r.id, sqlerrm)); end;
  end loop;
end $$;

-- 4. Every request is served by a live ride or unmet with a reason; nothing is left in limbo.
insert into qa_viol
select 'REQUEST_UNHANDLED', format('request %s (%s) is still %s after the solve', q.id, (select full_name from public.profiles where id = q.requester_id), q.status)
from public.requests q
where q.department_id = :'dept' and q.week_start = :'week' and q.status = 'submitted';

insert into qa_viol
select 'SERVED_WITHOUT_RIDE', format('request %s (%s) is %s but has no live ride', q.id, (select full_name from public.profiles where id = q.requester_id), q.status)
from public.requests q
where q.department_id = :'dept' and q.week_start = :'week' and q.status in ('assigned', 'merged')
  and not exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id where rr.request_id = q.id and r.status <> 'cancelled');

insert into qa_viol
select 'UNMET_WITHOUT_REASON', format('request %s is %s with no status_reason', q.id, q.status)
from public.requests q
where q.department_id = :'dept' and q.week_start = :'week' and q.status = 'waitlisted' and coalesce(q.status_reason, '') = '';

-- 5. A private (temporary) car only ever carries its owner.
insert into qa_viol
select 'TEMP_CAR_NOT_OWNER', format('ride %s on private car %s is driven by %s, not its owner', r.id, c.name, coalesce(r.driver_id::text, 'nobody'))
from public.rides r join public.cars c on c.id = r.car_id
where r.department_id = :'dept' and r.week_start = :'week' and r.status <> 'cancelled' and c.type = 'temporary' and r.driver_id is distinct from c.owner_id;

select 'VIOLATION', code, detail from qa_viol order by code, detail;
select 'STAT', 'rides', count(*) from public.rides where department_id = :'dept' and week_start = :'week' and status <> 'cancelled';
select 'STAT', 'requests_' || status, count(*) from public.requests where department_id = :'dept' and week_start = :'week' group by status order by status;
select 'STAT', 'status_reason_' || coalesce(status_reason, 'none'), count(*) from public.requests where department_id = :'dept' and week_start = :'week' and status = 'waitlisted' group by status_reason order by status_reason;
