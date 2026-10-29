-- O28-4 (owner 2026-10-28): leftover drafts end with the week. When a week becomes `archived`, its `draft` proposals
-- become `withdrawn` (the status guard allows draft -> withdrawn and leaves the request alone; a draft has no
-- notices, so nobody is told). Proposal rows are never deleted (change log, audit, solver reviews).
-- advance_week_phases: full definition from schema-current.sql plus the draft withdrawal in the archive loop; then a
-- one-time cleanup for weeks that are already archived.

create or replace function public.advance_week_phases("p_now" timestamp with time zone DEFAULT "now"()) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_count int := 0;
  v_n int;
  v_dept record;
  v_week record;
  v_archived record;
  v_prev_reason text;
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
    -- O28-4: the week's leftover board drafts end with it.
    v_prev_reason := current_setting('app.audit_reason', true);
    perform set_config('app.audit_reason', 'week_archived_withdraw_drafts', true);
    update public.proposals set status = 'withdrawn'
    where department_id = v_archived.department_id and week_start = v_archived.week_start and status = 'draft';
    perform set_config('app.audit_reason', coalesce(v_prev_reason, ''), true);
  end loop;

  update public.weeks set phase = 'live'
  where phase = 'published' and week_start <= ((p_now at time zone 'Asia/Jerusalem')::date - extract(dow from p_now at time zone 'Asia/Jerusalem')::int);

  return v_count;
end;
$$;

-- One-time cleanup: drafts left in weeks that are already archived.
select set_config('app.audit_reason', 'week_archived_withdraw_drafts', true);
update public.proposals p set status = 'withdrawn'
from public.weeks w
where w.department_id = p.department_id and w.week_start = p.week_start and w.phase = 'archived' and p.status = 'draft';
select set_config('app.audit_reason', '', true);
