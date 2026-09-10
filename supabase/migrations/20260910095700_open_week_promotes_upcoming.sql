-- open_week(): an admin/Sadran manually opening a week that already exists in phase
-- 'upcoming' (created by submit_series_request for a far multi-day leg, REQ §13.77)
-- promotes it to 'open' instead of silently doing nothing. The promotion UPDATE fires
-- notify_week_opened_on_promotion (20260910095100); the explicit enqueue below shares
-- the same dedupe key, so members still get exactly one window_open notice.
create or replace function public.open_week(p_department_id uuid, p_week_start date)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_settings record;
  v_open_at timestamptz;
  v_close_at timestamptz;
  v_publish_at timestamptz;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  select * into v_settings from public.department_settings where department_id = p_department_id;

  v_open_at := ((p_week_start - 7 + v_settings.open_dow) + v_settings.open_time) at time zone 'Asia/Jerusalem';
  v_close_at := ((p_week_start - 7 + v_settings.close_dow) + v_settings.close_time) at time zone 'Asia/Jerusalem';
  v_publish_at := ((p_week_start - 7 + v_settings.publish_dow) + v_settings.publish_time) at time zone 'Asia/Jerusalem';

  perform set_config('app.audit_reason', 'open_week', true);
  insert into public.weeks (department_id, week_start, phase, open_at, close_at, publish_at, opened_by)
  values (p_department_id, p_week_start, 'open', v_open_at, v_close_at, v_publish_at, (select auth.uid()))
  on conflict (department_id, week_start) do update
    set phase = 'open', opened_by = excluded.opened_by
    where public.weeks.phase = 'upcoming';

  perform public.enqueue_notification(dm.profile_id, 'window_open', p_department_id, p_week_start,
    '{}'::jsonb, '{}'::jsonb, format('window_open:%s:%s', p_department_id, p_week_start))
  from public.department_members dm where dm.department_id = p_department_id and dm.removed_at is null;

  return p_department_id;
end;
$function$;
