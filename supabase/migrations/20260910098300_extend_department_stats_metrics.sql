-- department_stats(): add servedRate, distinctPeople/distinctDrivers, byRideType and the
-- weekly series. REQ §13.78; DATA_MODEL.md §7.6.
--
-- - requests.servedRate = granted / total (0 when total = 0); requests.unmetRate kept.
-- - distinctPeople: distinct member profiles who rode in a shared car in range, as driver
--   or passenger — union of served requests' requester_id (ride_requests join, status
--   assigned/merged), rides.driver_id (covers chauffeur rides, which have no driver
--   request), and request_companions of those same served requests. Named children
--   (request_children) and guest_passenger_names are NOT profiles and are not counted.
--   distinctDrivers = distinct rides.driver_id over the same ride set, as a sub-line.
-- - byRideType: one entry per ride type touched by the same ride set, ride type taken from
--   the ride's driver request when one exists, else the lowest-id served request (covers
--   chauffeur rides); rides with no served request at all fall into the null-id 'other'
--   bucket. `hours` reuses the same [06:00,22:00) clipping as activeHours, per ride (a ride
--   never spans two Jerusalem calendar days, `assert_same_day_window()`). Ordered by rides
--   desc, id tie-break.
-- - weekly: one entry per week whose week_start falls in [p_from - 6, p_to] for the
--   department (weeks overlapping the requested range). An `archived` week with a
--   `week_stats` row reads it (`provisional: false`); every other week is computed live
--   with the identical per-week expressions (`provisional: true`) — waiting-list outcomes
--   settle during the week, so only an archived week's cache is treated as final.
--
-- Full body copied from the live definition (20260910098100_add_department_stats_earliest.sql)
-- via pg_get_functiondef and extended in place; no other behavior changes.

create or replace function public.department_stats(p_department_id uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_days int;
  v_shared_cars int;
  v_capacity_hours numeric;
  v_active_hours numeric;
  v_requests_total int;
  v_granted int;
  v_unmet int;
  v_cancelled int;
  v_rides int;
  v_weekday jsonb;
  v_policy_avg numeric;
  v_policy_weeks int;
  v_earliest date;
  v_today date;
  v_distinct_people int;
  v_distinct_drivers int;
  v_by_ride_type jsonb;
  v_weekly jsonb;
begin
  if not (public.is_admin() or public.is_sadran_any(p_department_id)) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  if p_to < p_from or (p_to - p_from + 1) > 400 then
    raise exception 'invalid_range' using errcode = 'P0001';
  end if;

  -- Earliest Jerusalem-calendar date with any data for the department, across
  -- weeks/rides/requests. LEAST() ignores individual NULL arguments and only returns
  -- NULL when every source is empty (documented Postgres behavior), matching "ignore
  -- nulls; null when nothing exists".
  select least(
    (select min(week_start) from public.weeks where department_id = p_department_id),
    (select min((starts_at at time zone 'Asia/Jerusalem')::date) from public.rides where department_id = p_department_id),
    (select min((depart_at at time zone 'Asia/Jerusalem')::date) from public.requests where department_id = p_department_id)
  ) into v_earliest;

  v_today := (now() at time zone 'Asia/Jerusalem')::date;

  -- Silently clamp instead of erroring: a range reaching before the department's earliest
  -- data, or past today, can never show real capacity for those days and would otherwise
  -- inflate/deflate the reported rate.
  if v_earliest is not null and p_from < v_earliest then
    p_from := v_earliest;
  end if;
  if p_to > v_today then
    p_to := v_today;
  end if;

  -- Defensive floor: a brand-new department whose only data is a future-dated week has
  -- earliest > today, so both clamps above can cross (from-clamp pushes p_from past the
  -- to-clamp's p_to). Not an error — there is simply no in-range day to report.
  v_days := greatest(p_to - p_from + 1, 0);

  select count(*) into v_shared_cars from public.cars
  where department_id = p_department_id and type = 'shared' and status = 'active';

  v_capacity_hours := v_shared_cars * v_days * 16;

  -- Per-(ride, Jerusalem calendar day) overlap with that day's [06:00, 22:00) window,
  -- for every non-cancelled ride on a shared car of the department that could touch the
  -- requested range at all (pruned via a plain timestamptz range check before the per-day
  -- clipping, so the day cross join stays small).
  with days as (
    select gs::date as d, extract(dow from gs)::int as dow
    from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') gs
  ),
  candidate_rides as (
    select r.id, r.starts_at, r.ends_at
    from public.rides r
    join public.cars c on c.id = r.car_id
    where r.department_id = p_department_id
      and c.type = 'shared'
      and r.status <> 'cancelled'
      and r.starts_at < ((p_to + 1)::timestamp at time zone 'Asia/Jerusalem')
      and r.ends_at > (p_from::timestamp at time zone 'Asia/Jerusalem')
  ),
  hours_by_day as (
    select dd.d, dd.dow,
      -- r.id is null on days with no matching ride (LEFT JOIN); LEAST/GREATEST ignore
      -- NULL arguments rather than propagating them, so without this guard a day with
      -- no ride at all would silently compute as a full 16-hour day.
      coalesce(sum(case when r.id is null then 0 else greatest(0::numeric, extract(epoch from (
          least(r.ends_at, ((dd.d + time '22:00') at time zone 'Asia/Jerusalem'))
          - greatest(r.starts_at, ((dd.d + time '06:00') at time zone 'Asia/Jerusalem'))
        )) / 3600.0) end), 0) as hours
    from days dd
    left join candidate_rides r
      on r.starts_at < ((dd.d + 1)::timestamp at time zone 'Asia/Jerusalem')
     and r.ends_at > (dd.d::timestamp at time zone 'Asia/Jerusalem')
    group by dd.d, dd.dow
  ),
  rides_by_day as (
    select dd.d, dd.dow, count(r.id) as n
    from days dd
    left join candidate_rides r
      on (r.starts_at at time zone 'Asia/Jerusalem')::date = dd.d
    group by dd.d, dd.dow
  ),
  -- All 7 weekdays are always present in the result, even when the range is shorter
  -- than a week and some weekday does not occur in it at all (occurrences = 0).
  occ as (
    select gs as dow, coalesce((select count(*) from days d where d.dow = gs), 0) as occurrences
    from generate_series(0, 6) gs
  ),
  by_dow as (
    select o.dow, o.occurrences,
      coalesce((select sum(h.hours) from hours_by_day h where h.dow = o.dow), 0) as total_hours,
      coalesce((select sum(rd.n) from rides_by_day rd where rd.dow = o.dow), 0) as total_rides
    from occ o
  )
  select coalesce((select sum(total_hours) from by_dow), 0),
    coalesce((select sum(total_rides) from by_dow), 0),
    jsonb_agg(jsonb_build_object(
      'dow', dow, 'occurrences', occurrences,
      'avgActiveHours', case when occurrences = 0 then 0 else round(total_hours / occurrences, 4) end,
      'avgRides', case when occurrences = 0 then 0 else round(total_rides / occurrences, 4) end,
      'utilizationRate', case when occurrences = 0 or v_shared_cars = 0 then 0
        else round((total_hours / occurrences) / (v_shared_cars * 16), 4) end
    ) order by dow)
  into v_active_hours, v_rides, v_weekday
  from by_dow;

  v_active_hours := coalesce(v_active_hours, 0);
  v_rides := coalesce(v_rides, 0);
  v_weekday := coalesce(v_weekday, '[]'::jsonb);

  with req as (
    select q.status
    from public.requests q
    where q.department_id = p_department_id
      and q.status not in ('draft', 'withdrawn')
      and (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date between p_from and p_to
  )
  select count(*),
    count(*) filter (where status in ('assigned', 'merged')),
    count(*) filter (where status in ('denied', 'external', 'waitlisted')),
    count(*) filter (where status = 'cancelled')
  into v_requests_total, v_granted, v_unmet, v_cancelled
  from req;

  -- Policy score: the latest siddur_versions row per week whose published_at falls in
  -- range (Jerusalem date), taking the department's active-policy alignment_ratio
  -- (`snapshot.policy_scores[].alignment_ratio` matching the top-level
  -- `snapshot.policy_version_id`, DATA_MODEL §3.9 "weighted coverage") — null/0 ignored.
  with latest as (
    select distinct on (s.week_start) s.week_start, s.snapshot
    from public.siddur_versions s
    where s.department_id = p_department_id
      and (s.published_at at time zone 'Asia/Jerusalem')::date between p_from and p_to
    order by s.week_start, s.version_no desc
  ),
  scored as (
    select (
      select (ps ->> 'alignment_ratio')::numeric
      from jsonb_array_elements(coalesce(l.snapshot -> 'policy_scores', '[]'::jsonb)) ps
      where ps ->> 'policy_version_id' = l.snapshot ->> 'policy_version_id'
      limit 1
    ) as score
    from latest l
  )
  select coalesce(avg(score) filter (where score is not null and score <> 0), 0),
    count(*) filter (where score is not null and score <> 0)
  into v_policy_avg, v_policy_weeks
  from scored;

  -- distinctPeople / distinctDrivers / byRideType: the same "served requests of a
  -- non-cancelled ride on a shared active car starting in range" ride set, shared by both.
  with range_rides as (
    select r.id, r.driver_id, r.starts_at, r.ends_at
    from public.rides r
    join public.cars c on c.id = r.car_id
    where r.department_id = p_department_id
      and c.type = 'shared' and c.status = 'active'
      and r.status <> 'cancelled'
      and (r.starts_at at time zone 'Asia/Jerusalem')::date between p_from and p_to
  ),
  served as (
    select rr.ride_id, rr.request_id, rr.role, q.requester_id
    from public.ride_requests rr
    join public.requests q on q.id = rr.request_id
    where rr.ride_id in (select id from range_rides)
      and q.status in ('assigned', 'merged')
  ),
  people as (
    select requester_id as profile_id from served
    union
    select driver_id as profile_id from range_rides
    union
    select rc.profile_id from served s join public.request_companions rc on rc.request_id = s.request_id
  )
  select coalesce((select count(distinct profile_id) from people), 0),
    coalesce((select count(distinct driver_id) from range_rides), 0)
  into v_distinct_people, v_distinct_drivers;

  with range_rides as (
    select r.id, r.starts_at, r.ends_at
    from public.rides r
    join public.cars c on c.id = r.car_id
    where r.department_id = p_department_id
      and c.type = 'shared' and c.status = 'active'
      and r.status <> 'cancelled'
      and (r.starts_at at time zone 'Asia/Jerusalem')::date between p_from and p_to
  ),
  ride_type_pick as (
    select rr.id as ride_id,
      (select q.ride_type_id from public.ride_requests x
         join public.requests q on q.id = x.request_id
         where x.ride_id = rr.id and q.status in ('assigned', 'merged')
         order by (x.role = 'driver') desc, x.request_id
         limit 1) as ride_type_id,
      greatest(0::numeric, extract(epoch from (
          least(rr.ends_at, (((rr.starts_at at time zone 'Asia/Jerusalem')::date + time '22:00') at time zone 'Asia/Jerusalem'))
          - greatest(rr.starts_at, (((rr.starts_at at time zone 'Asia/Jerusalem')::date + time '06:00') at time zone 'Asia/Jerusalem'))
        )) / 3600.0) as hrs
    from range_rides rr
  ),
  grouped as (
    select ride_type_id, count(*) as cnt, sum(hrs) as hrs_sum
    from ride_type_pick
    group by ride_type_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'rideTypeId', rt.id, 'code', coalesce(rt.code, 'other'), 'name', rt.name_he,
      'rides', g.cnt, 'hours', round(g.hrs_sum, 4)
    ) order by g.cnt desc, rt.id asc nulls last), '[]'::jsonb)
  into v_by_ride_type
  from grouped g
  left join public.ride_types rt on rt.id = g.ride_type_id;

  -- Weekly series: every week of the department whose week_start falls in
  -- [p_from - 6, p_to] (weeks overlapping the requested range). An archived week with a
  -- cached week_stats row is final (provisional: false); everything else is computed live,
  -- with the identical per-week expressions compute_week_stats() itself uses
  -- (20260910098200_create_week_stats.sql), over that week's own 7 days regardless of
  -- p_from/p_to (provisional: true).
  with target_weeks as (
    select w.week_start, w.phase
    from public.weeks w
    where w.department_id = p_department_id
      and w.week_start between (p_from - 6) and p_to
  ),
  cached as (
    select tw.week_start, ws.total_requests, ws.granted, ws.unmet, ws.cancelled, ws.rides
    from target_weeks tw
    join public.week_stats ws on ws.department_id = p_department_id and ws.week_start = tw.week_start
    where tw.phase = 'archived'
  ),
  live_weeks as (
    select tw.week_start
    from target_weeks tw
    where not exists (select 1 from cached c where c.week_start = tw.week_start)
  ),
  live as (
    select lw.week_start,
      (select count(*) from public.requests q where q.department_id = p_department_id
         and q.status not in ('draft', 'withdrawn')
         and (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date
           between lw.week_start and lw.week_start + 6) as total_requests,
      (select count(*) from public.requests q where q.department_id = p_department_id
         and q.status in ('assigned', 'merged')
         and (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date
           between lw.week_start and lw.week_start + 6) as granted,
      (select count(*) from public.requests q where q.department_id = p_department_id
         and q.status in ('denied', 'external', 'waitlisted')
         and (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date
           between lw.week_start and lw.week_start + 6) as unmet,
      (select count(*) from public.requests q where q.department_id = p_department_id
         and q.status = 'cancelled'
         and (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date
           between lw.week_start and lw.week_start + 6) as cancelled,
      (select count(*) from public.rides r join public.cars c on c.id = r.car_id
         where r.department_id = p_department_id and c.type = 'shared' and c.status = 'active'
         and r.status <> 'cancelled'
         and (r.starts_at at time zone 'Asia/Jerusalem')::date
           between lw.week_start and lw.week_start + 6) as rides
    from live_weeks lw
  )
  select coalesce(jsonb_agg(entry order by week_start), '[]'::jsonb) into v_weekly
  from (
    select week_start, jsonb_build_object('weekStart', week_start, 'total', total_requests,
      'granted', granted, 'unmet', unmet, 'cancelled', cancelled, 'rides', rides,
      'provisional', false) as entry
    from cached
    union all
    select week_start, jsonb_build_object('weekStart', week_start, 'total', total_requests,
      'granted', granted, 'unmet', unmet, 'cancelled', cancelled, 'rides', rides,
      'provisional', true) as entry
    from live
  ) combined;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'days', v_days, 'earliest', v_earliest,
    'sharedCars', v_shared_cars,
    'utilization', jsonb_build_object(
      'activeHours', round(v_active_hours, 4),
      'capacityHours', v_capacity_hours,
      'rate', case when v_capacity_hours = 0 then 0 else round(v_active_hours / v_capacity_hours, 4) end
    ),
    'requests', jsonb_build_object(
      'total', v_requests_total, 'granted', v_granted, 'unmet', v_unmet, 'cancelled', v_cancelled,
      'unmetRate', case when v_requests_total = 0 then 0 else round(v_unmet::numeric / v_requests_total, 4) end,
      'servedRate', case when v_requests_total = 0 then 0 else round(v_granted::numeric / v_requests_total, 4) end
    ),
    'rides', v_rides,
    'byWeekday', v_weekday,
    'policyScore', jsonb_build_object('average', round(v_policy_avg, 4), 'weeks', v_policy_weeks),
    'distinctPeople', v_distinct_people,
    'distinctDrivers', v_distinct_drivers,
    'byRideType', v_by_ride_type,
    'weekly', v_weekly
  );
end;
$$;

-- Same signature as 20260910098100: CREATE OR REPLACE preserves the existing grant, but
-- restate it explicitly (idempotent) to match repository convention.
revoke execute on function public.department_stats(uuid, date, date) from public, anon;
grant execute on function public.department_stats(uuid, date, date) to authenticated;
