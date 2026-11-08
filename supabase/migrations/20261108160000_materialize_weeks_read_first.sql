-- PF1: `ensure_department_weeks` runs on every app open (6,506 calls, 67 ms average in production). Its
-- `materialize_department_weeks` upserted every open-ahead week each time; when the row already existed past
-- `upcoming` the `on conflict do update … where phase = 'upcoming'` changed nothing but still locked the row, so
-- the call wrote and committed a transaction (WAL flush). A week that already exists past `upcoming` is now
-- skipped before the upsert: same rows, same count, and the usual call is read-only.

create or replace function public.materialize_department_weeks(p_department_id uuid, p_now timestamptz) returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
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
    if exists(select 1 from public.weeks w
               where w.department_id=p_department_id and w.week_start=target and w.phase<>'upcoming') then
      continue;
    end if;
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
