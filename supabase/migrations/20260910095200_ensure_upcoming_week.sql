-- REQ §13.77 — ensure_upcoming_week() materializes a `weeks` row, in phase
-- 'upcoming', for a (department, week_start) that submit_series_request() needs as a
-- composite-FK target before the department's normal opening horizon would create it.
-- Internal only: no direct caller-controlled clock/horizon, reachable only from other
-- SECURITY DEFINER functions (submit_series_request); not granted to authenticated.
create function public.ensure_upcoming_week(p_department_id uuid, p_week_start date) returns void
security definer set search_path = public, pg_temp language plpgsql as $$
declare settings public.department_settings%rowtype; times record;
begin
  select ds.* into settings from public.department_settings ds
    join public.departments d on d.id=ds.department_id
    where ds.department_id=p_department_id and d.is_active;
  if not found then
    raise exception 'series_week_not_open' using errcode = 'MDR01';
  end if;
  select * into times from public.week_phase_timestamps(settings, p_week_start);
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(p_department_id,p_week_start,'upcoming',times.open_at,times.close_at,times.publish_at)
    on conflict(department_id,week_start) do nothing;
end $$;
revoke all on function public.ensure_upcoming_week(uuid,date) from public,anon,authenticated;
