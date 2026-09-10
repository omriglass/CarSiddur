-- REQ §13.77 — factor the open/close/publish timestamp computation shared by
-- materialize_department_weeks() (20260908122000_week_opening.sql) and the new
-- ensure_upcoming_week() (20260910095200) into one helper, then teach
-- materialize_department_weeks()/advance_week_phases() to promote an already-materialized
-- `upcoming` week to `open` at its normal opening time instead of skipping it (the prior
-- `on conflict ... do nothing` left it stuck as `upcoming` forever).
--
-- stable, not immutable: the `at time zone` conversion depends on the tz database
-- (CLAUDE.md hard rule 6) even though it is a pure function of its arguments.
create function public.week_phase_timestamps(p_settings public.department_settings, p_week_start date)
returns table(open_at timestamptz, close_at timestamptz, publish_at timestamptz)
language sql stable set search_path = public, pg_temp as $$
  select
    ((p_week_start - 7 + p_settings.open_dow) + p_settings.open_time) at time zone 'Asia/Jerusalem',
    ((p_week_start - 7 + p_settings.close_dow) + p_settings.close_time) at time zone 'Asia/Jerusalem',
    ((p_week_start - 7 + p_settings.publish_dow) + p_settings.publish_time) at time zone 'Asia/Jerusalem';
$$;
revoke all on function public.week_phase_timestamps(public.department_settings, date) from public, anon, authenticated;

-- Catch up missed openings without reopening closed or published weeks. Unchanged except:
-- uses week_phase_timestamps(), and an `upcoming` week already materialized for a series
-- leg is promoted to `open` (via on conflict ... do update, guarded to the 'upcoming' row)
-- instead of being left alone by `do nothing`.
create or replace function public.materialize_department_weeks(p_department_id uuid,p_now timestamptz) returns int
security definer set search_path = public, pg_temp language plpgsql as $$
declare settings public.department_settings%rowtype; target date; local_day date;
  times record; n int; total int:=0;
begin
  select ds.* into settings from public.department_settings ds
    join public.departments d on d.id=ds.department_id
    where ds.department_id=p_department_id and d.is_active;
  if not found then return 0; end if;
  local_day:=(p_now at time zone 'Asia/Jerusalem')::date;
  for offset_weeks in 0..greatest(0,settings.weeks_open_ahead) loop
    target:=local_day-extract(dow from local_day)::int+7*offset_weeks;
    select * into times from public.week_phase_timestamps(settings, target);
    if times.open_at > p_now then continue; end if;
    insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
      values(p_department_id,target,'open',times.open_at,times.close_at,times.publish_at)
      on conflict(department_id,week_start) do update
        set phase='open', open_at=excluded.open_at, close_at=excluded.close_at, publish_at=excluded.publish_at
        where public.weeks.phase='upcoming';
    get diagnostics n=row_count;
    total:=total+n;
  end loop;
  return total;
end $$;
revoke all on function public.materialize_department_weeks(uuid,timestamptz) from public,anon,authenticated;

-- The 'upcoming' -> 'open' transition above is an UPDATE, so the existing
-- notify_week_opened() trigger (AFTER INSERT only) never sees it. Reuse the same function
-- (its body only reads NEW and only acts when new.phase = 'open') from a second, UPDATE-only
-- trigger that fires exactly on that transition — never on the 'upcoming' insert, never on
-- other week updates (settings_overrides, published_days, ...).
create trigger notify_week_opened_on_promotion after update of phase on public.weeks
  for each row when (old.phase = 'upcoming' and new.phase = 'open')
  execute function public.notify_week_opened();

-- advance_week_phases(): unchanged solving/live/archived logic, plus promoting any
-- 'upcoming' week whose open_at has arrived (covers a department whose normal
-- weeks_open_ahead horizon would not otherwise reach it yet) and, symmetrically to
-- materialize_department_weeks(), never touching 'upcoming' weeks in the solving/archived
-- passes below.
create or replace function public.advance_week_phases(p_now timestamptz default now()) returns int
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_count int := 0;
  v_n int;
  v_dept record;
  v_week record;
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

  update public.weeks set phase = 'archived'
  where phase in ('published', 'live') and (week_start + 7) <= (p_now at time zone 'Asia/Jerusalem')::date;

  update public.weeks set phase = 'live'
  where phase = 'published' and week_start <= ((p_now at time zone 'Asia/Jerusalem')::date - extract(dow from p_now at time zone 'Asia/Jerusalem')::int);

  return v_count;
end;
$$;

revoke execute on function public.advance_week_phases(timestamptz) from public, anon, authenticated;
