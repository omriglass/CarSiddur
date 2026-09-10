-- Weekly archival statistics cache. REQ §13.78 (owner follow-up: weekly graph of
-- non-accepted requests, precomputed at archival because waiting-list outcomes settle
-- during the week); DATA_MODEL.md §7.6 ("weekly" series), §8 retention.
--
-- `week_stats` caches, per (department, week), exactly the figures `department_stats()`
-- already knows how to compute (requests total/granted/unmet/cancelled, non-cancelled
-- rides on a shared active car, active hours clipped to the department's [06:00,22:00)
-- window, and distinct people who rode) so that once a week is `archived` its numbers are
-- read from a stored row instead of recomputed on every stats-page load. `compute_week_stats()`
-- is the only writer (SECURITY DEFINER, revoked from authenticated); there is no direct
-- INSERT/UPDATE policy, matching the RPC-only write convention used throughout (DATA_MODEL
-- §0/§4.3).
create table public.week_stats (
  department_id uuid not null,
  week_start date not null,
  total_requests int not null default 0,
  granted int not null default 0,
  unmet int not null default 0,
  cancelled int not null default 0,
  rides int not null default 0,
  active_hours numeric not null default 0,
  distinct_people int not null default 0,
  computed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (department_id, week_start),
  constraint week_stats_week_fk foreign key (department_id, week_start) references public.weeks (department_id, week_start),
  constraint week_stats_total_requests_ck check (total_requests >= 0),
  constraint week_stats_granted_ck check (granted >= 0),
  constraint week_stats_unmet_ck check (unmet >= 0),
  constraint week_stats_cancelled_ck check (cancelled >= 0),
  constraint week_stats_rides_ck check (rides >= 0),
  constraint week_stats_active_hours_ck check (active_hours >= 0),
  constraint week_stats_distinct_people_ck check (distinct_people >= 0)
);

create trigger set_updated_at before update on public.week_stats
  for each row execute function public.set_updated_at();

alter table public.week_stats enable row level security;
alter table public.week_stats force row level security;

-- Same authorization vocabulary as department_stats() itself (§7.6): admins, and the
-- department's Sadranim (any week), may read the cache; no other role, and no write policy
-- at all (compute_week_stats() runs SECURITY DEFINER and is the only writer).
create policy "week_stats_select" on public.week_stats for select to authenticated
  using (public.is_admin() or public.is_sadran_any(department_id));

-- ---------------------------------------------------------------------------
-- compute_week_stats(): same definitions as department_stats() (DATA_MODEL §7.6), scoped to
-- one week's own 7 Jerusalem-calendar days [week_start, week_start+6] regardless of any
-- caller-supplied range. Upserts one week_stats row.
-- ---------------------------------------------------------------------------
create or replace function public.compute_week_stats(p_department_id uuid, p_week_start date) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_from date := p_week_start;
  v_to date := p_week_start + 6;
  v_total int; v_granted int; v_unmet int; v_cancelled int;
  v_rides int; v_active_hours numeric; v_distinct_people int;
begin
  with req as (
    select q.status
    from public.requests q
    where q.department_id = p_department_id
      and q.status not in ('draft', 'withdrawn')
      and (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date between v_from and v_to
  )
  select count(*),
    count(*) filter (where status in ('assigned', 'merged')),
    count(*) filter (where status in ('denied', 'external', 'waitlisted')),
    count(*) filter (where status = 'cancelled')
  into v_total, v_granted, v_unmet, v_cancelled
  from req;

  with counted_rides as (
    select r.id, r.driver_id, r.starts_at, r.ends_at,
      (r.starts_at at time zone 'Asia/Jerusalem')::date as d
    from public.rides r
    join public.cars c on c.id = r.car_id
    where r.department_id = p_department_id
      and c.type = 'shared' and c.status = 'active'
      and r.status <> 'cancelled'
      and (r.starts_at at time zone 'Asia/Jerusalem')::date between v_from and v_to
  ),
  hours as (
    select cr.id,
      greatest(0::numeric, extract(epoch from (
        least(cr.ends_at, ((cr.d + time '22:00') at time zone 'Asia/Jerusalem'))
        - greatest(cr.starts_at, ((cr.d + time '06:00') at time zone 'Asia/Jerusalem'))
      )) / 3600.0) as hrs
    from counted_rides cr
  ),
  served as (
    select rr.ride_id, rr.request_id, q.requester_id
    from public.ride_requests rr
    join public.requests q on q.id = rr.request_id
    where rr.ride_id in (select id from counted_rides)
      and q.status in ('assigned', 'merged')
  ),
  people as (
    select requester_id as profile_id from served
    union
    select driver_id as profile_id from counted_rides
    union
    select rc.profile_id from served s join public.request_companions rc on rc.request_id = s.request_id
  )
  select coalesce((select count(*) from counted_rides), 0),
    coalesce((select sum(hrs) from hours), 0),
    coalesce((select count(distinct profile_id) from people), 0)
  into v_rides, v_active_hours, v_distinct_people;

  insert into public.week_stats (department_id, week_start, total_requests, granted, unmet, cancelled,
    rides, active_hours, distinct_people, computed_at)
  values (p_department_id, p_week_start, v_total, v_granted, v_unmet, v_cancelled,
    v_rides, v_active_hours, v_distinct_people, now())
  on conflict (department_id, week_start) do update set
    total_requests = excluded.total_requests,
    granted = excluded.granted,
    unmet = excluded.unmet,
    cancelled = excluded.cancelled,
    rides = excluded.rides,
    active_hours = excluded.active_hours,
    distinct_people = excluded.distinct_people,
    computed_at = excluded.computed_at;
end;
$$;

revoke all on function public.compute_week_stats(uuid, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- advance_week_phases(): unchanged except the published/live -> archived transition now
-- captures the rows it just archived and computes their week_stats immediately (the tick
-- runs every 15 minutes, so this is the natural, idempotent moment to cache a week's final
-- numbers — waiting-list outcomes have settled by the time a week leaves `live`).
-- Full body copied from the live definition (20260910095100_promote_upcoming_weeks_to_open.sql)
-- and extended in place; no other behavior changes.
-- ---------------------------------------------------------------------------
create or replace function public.advance_week_phases(p_now timestamptz default now()) returns int
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_count int := 0;
  v_n int;
  v_dept record;
  v_week record;
  v_archived record;
begin
  for v_dept in select id from public.departments where is_active loop
    v_count := v_count + public.materialize_department_weeks(v_dept.id, p_now);
  end loop;

  update public.weeks set phase = 'open' where phase = 'upcoming' and open_at <= p_now;
  get diagnostics v_n = row_count;
  v_count := v_count + v_n;

  for v_week in select * from public.weeks where phase = 'open' and close_at <= p_now loop
    update public.weeks set phase = 'solving' where department_id = v_week.department_id and week_start = v_week.week_start;
    perform public.enqueue_notification(s.profile_id, 'window_closed_solve_now', v_week.department_id, v_week.week_start,
      '{}'::jsonb, '{}'::jsonb, format('window_closed_solve_now:%s:%s', v_week.department_id, v_week.week_start))
    from public.sadranim_of(v_week.department_id, v_week.week_start) as s(profile_id);
    v_count := v_count + 1;
  end loop;

  for v_archived in
    update public.weeks set phase = 'archived'
    where phase in ('published', 'live') and (week_start + 7) <= (p_now at time zone 'Asia/Jerusalem')::date
    returning department_id, week_start
  loop
    perform public.compute_week_stats(v_archived.department_id, v_archived.week_start);
  end loop;

  update public.weeks set phase = 'live'
  where phase = 'published' and week_start <= ((p_now at time zone 'Asia/Jerusalem')::date - extract(dow from p_now at time zone 'Asia/Jerusalem')::int);

  return v_count;
end;
$$;

revoke execute on function public.advance_week_phases(timestamptz) from public, anon, authenticated;

-- Backfill: every week already `archived` before this migration gets its week_stats row now,
-- instead of waiting for its next (nonexistent, since it is already archived) phase transition.
do $$
declare v_week record;
begin
  for v_week in select department_id, week_start from public.weeks where phase = 'archived' loop
    perform public.compute_week_stats(v_week.department_id, v_week.week_start);
  end loop;
end $$;
