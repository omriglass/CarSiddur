-- REQ §13.173 (c) (production P1101-3, 2026-11-01): a week is archived once it has ended whatever its phase.
-- Before, only `published`/`live` weeks were archived, so a week never published stayed `open`/`solving` forever
-- (נבו 18.10 and 25.10). Archiving now runs before the open -> solving step, so an ended open week is archived
-- without first sending the Sadranim "the window closed, solve now". Rides of such a week stay as they are.

create or replace function public.advance_week_phases(p_now timestamptz default now()) returns integer
    language plpgsql security definer
    set search_path = public, pg_temp
    as $$
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

  for v_archived in
    update public.weeks set phase = 'archived'
    where phase in ('open', 'solving', 'published', 'live') and (week_start + 7) <= (p_now at time zone 'Asia/Jerusalem')::date
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

  for v_week in select * from public.weeks where phase = 'open' and close_at <= p_now loop
    update public.weeks set phase = 'solving' where department_id = v_week.department_id and week_start = v_week.week_start;
    perform public.enqueue_notification(s.profile_id, 'window_closed_solve_now', v_week.department_id, v_week.week_start,
      '{}'::jsonb, '{}'::jsonb, format('window_closed_solve_now:%s:%s', v_week.department_id, v_week.week_start))
    from public.sadranim_of(v_week.department_id, v_week.week_start) as s(profile_id);
    v_count := v_count + 1;
  end loop;

  update public.weeks set phase = 'live'
  where phase = 'published' and week_start <= ((p_now at time zone 'Asia/Jerusalem')::date - extract(dow from p_now at time zone 'Asia/Jerusalem')::int);

  return v_count;
end;
$$;
