-- REQ §13.108 (f) / docs/TODO.md U3 — "be back on time": for every visible ride, the ride that
-- comes right before and right after it on the same car, and whether the gap is tight.
--
-- One source of truth, read by the browser (my rides, Home cards, the siddur ride sheet).
-- security_invoker: rides / ride_requests / requests / ride_passengers are read as the signed-in
-- member, so a member only ever learns about rides RLS already shows them. On top of that the
-- neighbour must sit on a PUBLISHED day (is_day_public) for everyone, the Sadran included.
--
-- threshold = greatest(week turnaround of THIS ride (per-week override included), 30) minutes.
-- The week turnaround is read inline (department_settings + weeks.settings_overrides, both readable
-- by department members) and ride_is_reservation() is inlined, because neither function is
-- executable by `authenticated` (hard rule 4; rls_smoke TEST 14 pins ride_is_reservation closed).
--
-- Counted neighbours: status confirmed/flagged, not planning_conflict, on a published day, not of
-- the same multi-day series (series_id). Cancelled rides never count. The other half of a one-way
-- relay pair, Sadran reservations and car moves are ordinary neighbours (kind tells them apart).

create index if not exists rides_car_starts_idx
  on public.rides (car_id, starts_at)
  where status <> 'cancelled';

create or replace view public.v_ride_car_neighbours with (security_invoker = true) as
select
  r.id as ride_id,
  th.minutes as threshold_minutes,
  nx.id as next_ride_id,
  nx.starts_at as next_starts_at,
  nx.kind as next_kind,
  nx.name as next_name,
  nx.people as next_people,
  case when nx.id is null then null
       else round(extract(epoch from (nx.starts_at - r.ends_at)) / 60)::int end as next_gap_minutes,
  coalesce(nx.id is not null and nx.starts_at - r.ends_at <= make_interval(mins => th.minutes), false) as next_tight,
  pv.id as prev_ride_id,
  pv.ends_at as prev_ends_at,
  pv.kind as prev_kind,
  pv.name as prev_name,
  pv.people as prev_people,
  case when pv.id is null then null
       else round(extract(epoch from (r.starts_at - pv.ends_at)) / 60)::int end as prev_gap_minutes,
  coalesce(pv.id is not null and r.starts_at - pv.ends_at <= make_interval(mins => th.minutes), false) as prev_tight
from public.rides r
cross join lateral (
  select greatest(coalesce((w.settings_overrides ->> 'turnaround_minutes')::int, s.turnaround_minutes, 30), 30) as minutes
  from (select 1) one
  left join public.department_settings s on s.department_id = r.department_id
  left join public.weeks w on w.department_id = r.department_id and w.week_start = r.week_start
) th
left join lateral (
  select n.id, n.starts_at, k.kind, nm.name, pe.people
  from public.rides n
  cross join lateral (
    select case
      when n.auto_relocation and n.pin_reason = 'CAR_MOVE' then 'car_move'
      when not n.auto_relocation and not exists (select 1 from public.ride_requests x where x.ride_id = n.id) then 'reservation'
      else 'ride' end as kind
  ) k
  cross join lateral (
    select coalesce(
      (select d.full_name from public.profiles d where d.id = n.driver_id),
      (select p.full_name
         from public.ride_requests rr
         join public.requests q on q.id = rr.request_id
         join public.profiles p on p.id = q.requester_id
        where rr.ride_id = n.id
        order by rr.created_at, rr.request_id
        limit 1),
      (select rp.display_name from public.ride_passengers rp where rp.ride_id = n.id order by rp.created_at, rp.id limit 1)
    ) as name
  ) nm
  cross join lateral (
    select coalesce(array_agg(distinct x.pid) filter (where x.pid is not null), '{}'::uuid[]) as people
    from (
      select n.driver_id as pid
      union all
      select q.requester_id
        from public.ride_requests rr join public.requests q on q.id = rr.request_id where rr.ride_id = n.id
      union all
      select rc.profile_id
        from public.ride_requests rr join public.request_companions rc on rc.request_id = rr.request_id where rr.ride_id = n.id
      union all
      select rp.person_id from public.ride_passengers rp where rp.ride_id = n.id
    ) x
  ) pe
  where n.car_id = r.car_id and n.id <> r.id
    and n.status in ('confirmed', 'flagged') and not n.planning_conflict
    and n.starts_at >= r.ends_at
    and (r.series_id is null or n.series_id is distinct from r.series_id)
    and public.is_day_public(n.department_id, n.week_start, (n.starts_at at time zone 'Asia/Jerusalem')::date)
  order by n.starts_at, n.id
  limit 1
) nx on true
left join lateral (
  select n.id, n.ends_at, k.kind, nm.name, pe.people
  from public.rides n
  cross join lateral (
    select case
      when n.auto_relocation and n.pin_reason = 'CAR_MOVE' then 'car_move'
      when not n.auto_relocation and not exists (select 1 from public.ride_requests x where x.ride_id = n.id) then 'reservation'
      else 'ride' end as kind
  ) k
  cross join lateral (
    select coalesce(
      (select d.full_name from public.profiles d where d.id = n.driver_id),
      (select p.full_name
         from public.ride_requests rr
         join public.requests q on q.id = rr.request_id
         join public.profiles p on p.id = q.requester_id
        where rr.ride_id = n.id
        order by rr.created_at, rr.request_id
        limit 1),
      (select rp.display_name from public.ride_passengers rp where rp.ride_id = n.id order by rp.created_at, rp.id limit 1)
    ) as name
  ) nm
  cross join lateral (
    select coalesce(array_agg(distinct x.pid) filter (where x.pid is not null), '{}'::uuid[]) as people
    from (
      select n.driver_id as pid
      union all
      select q.requester_id
        from public.ride_requests rr join public.requests q on q.id = rr.request_id where rr.ride_id = n.id
      union all
      select rc.profile_id
        from public.ride_requests rr join public.request_companions rc on rc.request_id = rr.request_id where rr.ride_id = n.id
      union all
      select rp.person_id from public.ride_passengers rp where rp.ride_id = n.id
    ) x
  ) pe
  where n.car_id = r.car_id and n.id <> r.id
    and n.status in ('confirmed', 'flagged') and not n.planning_conflict
    and n.ends_at <= r.starts_at
    and (r.series_id is null or n.series_id is distinct from r.series_id)
    and public.is_day_public(n.department_id, n.week_start, (n.starts_at at time zone 'Asia/Jerusalem')::date)
  order by n.ends_at desc, n.id
  limit 1
) pv on true
where r.status in ('confirmed', 'flagged');

revoke all on public.v_ride_car_neighbours from public, anon, authenticated;
grant select on public.v_ride_car_neighbours to authenticated;
