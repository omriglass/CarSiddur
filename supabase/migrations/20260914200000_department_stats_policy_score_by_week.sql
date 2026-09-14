-- Bug fix (2026-09-14, owner report): department_stats().policyScore selected weeks by
-- publication date instead of target week. Looking at "last week" in /stats showed no
-- policy score whenever that week's siddur was published the Wednesday before -- outside
-- the queried [p_from, p_to] range even though the week itself is squarely inside it.
--
-- Full function body copied verbatim from 20260914190000_unified_ride_people.sql (CLAUDE.md
-- hard rule 8 -- functions aren't hand-patchable) with exactly one change: the "Policy
-- score" CTE now selects the latest siddur_versions row per week_start whose TARGET WEEK
-- overlaps the requested range (`s.week_start <= p_to and s.week_start + 6 >= p_from`)
-- instead of filtering by `published_at`. "Latest version_no per week_start" and the
-- null/0-score filter are unchanged.
create or replace function public.department_stats(p_department_id uuid, p_from date, p_to date)
returns jsonb
security definer stable set search_path = public, pg_temp
language plpgsql as $$
declare
  v_days int;
  v_shared_cars int;
  v_capacity_hours numeric;
  v_active_hours numeric;
  v_turnaround_minutes int;
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
  -- S2 sharing indicators
  v_sharing_people numeric;
  v_sharing_seats numeric;
  v_people_utilization numeric;
  v_frag_ride_count int;
  v_active_car_days int;
  v_fragmentation numeric;
  v_one_way_total int;
  v_one_way_served int;
  v_one_way_fulfilment numeric;
  -- S3 same-day cancellations
  v_cancel_total int;
  v_cancel_same_day int;
  v_cancel_same_day_rate numeric;
  -- S4 requests by hour
  v_requests_by_hour jsonb;
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
  -- to-clamp's p_to). Not an error -- there is simply no in-range day to report.
  v_days := greatest(p_to - p_from + 1, 0);

  -- S1: the department's configured turnaround buffer, applied to every ride's occupied span
  -- below (default 30 when the singleton row is somehow missing -- it is auto-created on
  -- department insert, so this is defensive only).
  select coalesce(turnaround_minutes, 30) into v_turnaround_minutes
  from public.department_settings where department_id = p_department_id;
  v_turnaround_minutes := coalesce(v_turnaround_minutes, 30);

  -- Capacity denominator only: a shared car not already retired before the range started.
  -- Deliberately NOT `status <> 'retired'` (which is what this used to be): that would also
  -- exclude a car retired *after* p_to, which was still available for the whole range being
  -- reported on. `retired_at` (20260910100300_track_car_retired_at.sql) is null for an
  -- active/maintenance car, so it always passes.
  --
  -- Correction to the brief that requested this rule: it also suggested gating on
  -- `created_at <= p_to` (a car "created after the range" should not count either). That
  -- reads right in isolation but breaks every far-past fixture range in this codebase's own
  -- test convention (e.g. supabase/tests/department_stats.sql builds its main fixture on
  -- `current_week_start() - 700`, while the seeded cars' `created_at` is whenever `db reset`
  -- last ran -- i.e. after `p_to`, not before it) -- `created_at` is a row-insertion
  -- timestamp, not a real fleet-acquisition date, and the existing `earliest` clamp already
  -- keeps the reported range from reaching before the department's first real week/ride/
  -- request. Dropped; reported as the correction.
  select count(*) into v_shared_cars from public.cars
  where department_id = p_department_id and type = 'shared'
    and (retired_at is null or (retired_at at time zone 'Asia/Jerusalem')::date >= p_from);

  v_capacity_hours := v_shared_cars * v_days * 16;

  -- Per-(ride, Jerusalem calendar day) overlap with that day's [06:00, 22:00) window,
  -- for every non-cancelled ride on a shared car of the department that could touch the
  -- requested range at all (pruned via a plain timestamptz range check before the per-day
  -- clipping, so the day cross join stays small).
  --
  -- S1 (2026-09-14): a ride's occupied end is `least(ends_at + turnaround_minutes, that
  -- day's 22:00)` instead of bare `ends_at` -- the turnaround buffer after a ride still ties
  -- up the car, so it counts toward "active" time the same as driving time (capped at the
  -- window this query already uses, exactly like the drive time itself).
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
          least(r.ends_at + make_interval(mins => v_turnaround_minutes), ((dd.d + time '22:00') at time zone 'Asia/Jerusalem'))
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

  -- Policy score (20260914200000): the latest siddur_versions row for every week whose
  -- TARGET WEEK overlaps the requested range (week_start <= p_to and week_start + 6 >=
  -- p_from -- week_start is the Sunday, the week runs Sun-Sat), not by publication date.
  -- A week can be published ahead of or after its own span (e.g. the Wednesday before it
  -- opens), so filtering by published_at could silently drop or include the wrong week;
  -- selecting by week_start instead answers "what was the policy score for the weeks in
  -- this range", matching every other per-week metric in this function (requests/rides/
  -- weekly). Still the department's active-policy alignment_ratio
  -- (`snapshot.policy_scores[].alignment_ratio` matching the top-level
  -- `snapshot.policy_version_id`, DATA_MODEL §3.9 "weighted coverage") -- null/0 ignored.
  with latest as (
    select distinct on (s.week_start) s.week_start, s.snapshot
    from public.siddur_versions s
    where s.department_id = p_department_id
      and s.week_start <= p_to and s.week_start + 6 >= p_from
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
  -- non-cancelled ride on a shared car (any status -- retiring a car keeps its history,
  -- 20260910100400) starting in range" ride set, shared by both.
  with range_rides as (
    select r.id, r.driver_id, r.starts_at, r.ends_at
    from public.rides r
    join public.cars c on c.id = r.car_id
    where r.department_id = p_department_id
      and c.type = 'shared'
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
    union
    -- Unified ride-people model (20260914190000): a directly-added `ride_passengers` row
    -- (the "+ נוסעים" button / a named reservation passenger) is a person on the ride
    -- exactly like a served request's requester or companion, so a distinct profile counts
    -- once here too, whether they were driven, requested, or simply added.
    select rp.person_id as profile_id
    from public.ride_passengers rp
    where rp.ride_id in (select id from range_rides) and rp.person_id is not null
  )
  select coalesce((select count(distinct profile_id) from people), 0),
    coalesce((select count(distinct driver_id) from range_rides), 0)
  into v_distinct_people, v_distinct_drivers;

  with range_rides as (
    select r.id, r.starts_at, r.ends_at
    from public.rides r
    join public.cars c on c.id = r.car_id
    where r.department_id = p_department_id
      and c.type = 'shared'
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
         where r.department_id = p_department_id and c.type = 'shared'
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

  -- S2: same-day sharing indicators. Same "non-cancelled ride on a shared car, starting in
  -- range" set as `rides`/`activeHours` above.
  with sharing_rides as (
    select r.id, r.car_id, r.driver_id,
      (r.starts_at at time zone 'Asia/Jerusalem')::date as d
    from public.rides r
    join public.cars c on c.id = r.car_id
    where r.department_id = p_department_id
      and c.type = 'shared'
      and r.status <> 'cancelled'
      and (r.starts_at at time zone 'Asia/Jerusalem')::date between p_from and p_to
  ),
  served_totals as (
    select rr.ride_id, sum(q.adults + q.child_seats + q.boosters) as total_people
    from public.ride_requests rr
    join public.requests q on q.id = rr.request_id
    where q.status in ('assigned', 'merged')
      and rr.ride_id in (select id from sharing_rides)
    group by rr.ride_id
  ),
  -- Unified ride-people model (20260914190000): a directly-added `ride_passengers` row is
  -- one more occupied seat on top of whatever the ride's served requests already account
  -- for (each row is exactly one person, regardless of its `seat_kind`).
  added_totals as (
    select rp.ride_id, count(*) as added_people
    from public.ride_passengers rp
    where rp.ride_id in (select id from sharing_rides)
    group by rp.ride_id
  ),
  ride_people as (
    -- A ride with a driver but no served request at all (chauffeur/administrative
    -- placeholder, same case the `distinctPeople` union handles via `rides.driver_id`)
    -- still counts its one occupant.
    select sr.id as ride_id, sr.car_id, sr.d,
      coalesce(st.total_people, case when sr.driver_id is not null then 1 else 0 end)
        + coalesce(at.added_people, 0) as people
    from sharing_rides sr
    left join served_totals st on st.ride_id = sr.id
    left join added_totals at on at.ride_id = sr.id
  ),
  car_max_seats as (
    select c.id as car_id,
      coalesce((
        select max(csc.adults + csc.child_seats + csc.boosters)
        from public.car_seat_configs csc where csc.car_id = c.id
      ), 5) as seats
    from public.cars c
    where c.department_id = p_department_id and c.type = 'shared'
  ),
  car_days as (
    select car_id, d, count(*) as n from sharing_rides group by car_id, d
  ),
  one_way_reqs as (
    select q.status
    from public.requests q
    where q.department_id = p_department_id
      and q.trip_shape <> 'round_trip'
      and q.status not in ('draft', 'withdrawn')
      and (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date between p_from and p_to
  )
  select
    coalesce((select sum(rp.people) from ride_people rp), 0),
    coalesce((select sum(cm.seats) from ride_people rp join car_max_seats cm on cm.car_id = rp.car_id), 0),
    coalesce((select sum(n) from car_days), 0),
    coalesce((select count(*) from car_days), 0),
    coalesce((select count(*) from one_way_reqs), 0),
    coalesce((select count(*) from one_way_reqs where status in ('assigned', 'merged')), 0)
  into v_sharing_people, v_sharing_seats, v_frag_ride_count, v_active_car_days,
    v_one_way_total, v_one_way_served;

  v_people_utilization := case when v_sharing_seats = 0 then 0 else round(v_sharing_people / v_sharing_seats, 4) end;
  v_fragmentation := case when v_active_car_days = 0 then 0
    else round(v_frag_ride_count::numeric / v_active_car_days, 4) end;
  v_one_way_fulfilment := case when v_one_way_total = 0 then 0
    else round(v_one_way_served::numeric / v_one_way_total, 4) end;

  -- S3: same-day cancellations. Shared-car rides that started in range and were cancelled;
  -- denominator is cancellations, not all rides (owner: cancelling is fine, last-minute
  -- cancelling is the problem).
  with cancelled_range_rides as (
    select r.cancelled_at, r.starts_at
    from public.rides r
    join public.cars c on c.id = r.car_id
    where r.department_id = p_department_id
      and c.type = 'shared'
      and r.status = 'cancelled'
      and (r.starts_at at time zone 'Asia/Jerusalem')::date between p_from and p_to
  )
  select count(*),
    count(*) filter (where (cancelled_at at time zone 'Asia/Jerusalem')::date = (starts_at at time zone 'Asia/Jerusalem')::date)
  into v_cancel_total, v_cancel_same_day
  from cancelled_range_rides;

  v_cancel_same_day_rate := case when v_cancel_total = 0 then 0
    else round(v_cancel_same_day::numeric / v_cancel_total, 4) end;

  -- S4: requests per hour of day. Always 24 entries; a request with no `depart_at` at all
  -- (a `one_way_from` return-only request) has nothing to bucket by and is simply absent
  -- from the count, not folded into hour 0.
  with hour_series as (
    select gs as hour from generate_series(0, 23) gs
  ),
  req_hours as (
    select extract(hour from (q.depart_at at time zone 'Asia/Jerusalem'))::int as hour
    from public.requests q
    where q.department_id = p_department_id
      and q.status not in ('draft', 'withdrawn')
      and q.depart_at is not null
      and (q.depart_at at time zone 'Asia/Jerusalem')::date between p_from and p_to
  ),
  by_hour as (
    select hour, count(*) as n from req_hours group by hour
  )
  select coalesce(jsonb_agg(jsonb_build_object('hour', hs.hour, 'count', coalesce(bh.n, 0)) order by hs.hour), '[]'::jsonb)
  into v_requests_by_hour
  from hour_series hs
  left join by_hour bh on bh.hour = hs.hour;

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
    'weekly', v_weekly,
    'sharing', jsonb_build_object(
      'peopleUtilization', v_people_utilization,
      'fragmentation', v_fragmentation,
      'fragmentationRideCount', v_frag_ride_count,
      'activeCarDays', v_active_car_days,
      'oneWayFulfilment', v_one_way_fulfilment,
      'oneWayServed', v_one_way_served,
      'oneWayTotal', v_one_way_total
    ),
    'cancellations', jsonb_build_object(
      'total', v_cancel_total, 'sameDay', v_cancel_same_day, 'sameDayRate', v_cancel_same_day_rate
    ),
    'requestsByHour', v_requests_by_hour
  );
end;
$$;

revoke execute on function public.department_stats(uuid, date, date) from public, anon;
grant execute on function public.department_stats(uuid, date, date) to authenticated;
