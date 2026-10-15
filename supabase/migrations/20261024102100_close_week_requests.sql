-- REQ §4 / §13.81 (2026-10-15): close a reopened week's request window without publishing.
-- reopen_week() leaves close_at at the end of the week and open_at just before now(), so
-- set_week_close_at() cannot express "close now". This RPC moves open -> solving, rides and
-- drafts untouched, and sends the Sadranim the same notice advance_week_phases() sends.
create or replace function public.close_week_requests(p_department_id uuid, p_week_start date)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  w public.weeks%rowtype;
  v_now timestamptz := now();
begin
  if not public.is_approved() or not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized';
  end if;

  select * into w from public.weeks where department_id = p_department_id and week_start = p_week_start for update;
  if not found or w.phase <> 'open' then
    raise exception 'week_close_not_editable';
  end if;

  perform set_config('app.audit_reason', 'close_week_requests', true);
  update public.weeks set phase = 'solving', close_at = v_now
    where department_id = p_department_id and week_start = p_week_start;

  perform public.enqueue_notification(s.profile_id, 'window_closed_solve_now', p_department_id, p_week_start,
    '{}'::jsonb, '{}'::jsonb, format('window_closed_solve_now:%s:%s:%s', p_department_id, p_week_start, v_now))
  from public.sadranim_of(p_department_id, p_week_start) as s(profile_id);
end;
$$;

revoke all on function public.close_week_requests(uuid, date) from public, anon;
grant execute on function public.close_week_requests(uuid, date) to authenticated;
