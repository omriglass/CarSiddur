-- Department statistics RPC for the admin and Sadran statistics screens.
-- REQ §13.78; DATA_MODEL.md §7.6 (example query), §6 (migration list).

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
begin
  if not (public.is_admin() or public.is_sadran_any(p_department_id)) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  if p_to < p_from or (p_to - p_from + 1) > 400 then
    raise exception 'invalid_range' using errcode = 'P0001';
  end if;

  v_days := p_to - p_from + 1;

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

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'days', v_days,
    'sharedCars', v_shared_cars,
    'utilization', jsonb_build_object(
      'activeHours', round(v_active_hours, 4),
      'capacityHours', v_capacity_hours,
      'rate', case when v_capacity_hours = 0 then 0 else round(v_active_hours / v_capacity_hours, 4) end
    ),
    'requests', jsonb_build_object(
      'total', v_requests_total, 'granted', v_granted, 'unmet', v_unmet, 'cancelled', v_cancelled,
      'unmetRate', case when v_requests_total = 0 then 0 else round(v_unmet::numeric / v_requests_total, 4) end
    ),
    'rides', v_rides,
    'byWeekday', v_weekday,
    'policyScore', jsonb_build_object('average', round(v_policy_avg, 4), 'weeks', v_policy_weeks)
  );
end;
$$;

revoke execute on function public.department_stats(uuid, date, date) from public, anon;
grant execute on function public.department_stats(uuid, date, date) to authenticated;
