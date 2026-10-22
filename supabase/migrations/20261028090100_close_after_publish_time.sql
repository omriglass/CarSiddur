-- REQ §13.141 (owner 2026-10-22): the request window may close later than the planned publish time — e.g. on
-- Thursday although the department publishes on Wednesday. The publish time no longer limits anything: when
-- the closing time is later it is pushed to the closing time (the same `greatest(publish_at, …)` the
-- close-now paths already use), so `weeks_time_order_ck` (close_at <= publish_at) keeps holding.
--   * set_week_close_at: the new closing time may be anything after the week opened and up to the start of
--     the target week (was: up to publish_at);
--   * week_phase_timestamps / open_week: a department default that closes after it publishes no longer makes
--     opening the week fail.

create or replace function public.set_week_close_at(p_department_id uuid, p_week_start date, p_close_at timestamptz)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  w public.weeks%rowtype;
  v_new_phase public.week_phase;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized';
  end if;

  select * into w from public.weeks where department_id = p_department_id and week_start = p_week_start for update;
  if not found or w.phase not in ('open', 'solving') then
    raise exception 'week_close_not_editable';
  end if;

  if p_close_at is null or p_close_at <= w.open_at
    or p_close_at > (p_week_start::timestamp at time zone 'Asia/Jerusalem')
    or not public.is_quarter_hour(p_close_at) then
    raise exception 'week_close_out_of_range';
  end if;

  v_new_phase := w.phase;
  if w.phase = 'solving' and p_close_at > now() then
    v_new_phase := 'open';
  elsif w.phase = 'open' and p_close_at <= now() then
    v_new_phase := 'solving';
  end if;

  perform set_config('app.audit_reason', 'set_week_close_at', true);
  update public.weeks set close_at = p_close_at, publish_at = greatest(publish_at, p_close_at), phase = v_new_phase
    where department_id = p_department_id and week_start = p_week_start;

  -- Same transition, same event and recipients as advance_week_phases()'s own open->solving
  -- branch — a fresh dedupe key (folding in the new close_at) so a later *natural* close
  -- (after the Sadran reopens and it elapses again via app.tick()) is never silently
  -- deduped against this manual one.
  if w.phase = 'open' and v_new_phase = 'solving' then
    perform public.enqueue_notification(s.profile_id, 'window_closed_solve_now', p_department_id, p_week_start,
      '{}'::jsonb, '{}'::jsonb, format('window_closed_solve_now:%s:%s:%s', p_department_id, p_week_start, p_close_at))
    from public.sadranim_of(p_department_id, p_week_start) as s(profile_id);
  end if;

  -- notification_context() reads weeks.close_at fresh, so the auto-computed {{weekLabel}}
  -- already reflects the row we just updated; closeDay/closeTime are explicit here because
  -- the auto {{closeTime}} is "DD/MM HH24:MI" (other window events), not the bare "HH:MM"
  -- this copy wants.
  perform public.enqueue_notification(dm.profile_id, 'window_changed', p_department_id, p_week_start,
    jsonb_build_object(
      'closeDay', public.weekday_short_label((p_close_at at time zone 'Asia/Jerusalem')::date),
      'closeTime', to_char(p_close_at at time zone 'Asia/Jerusalem', 'HH24:MI')
    ),
    '{}'::jsonb,
    format('window_changed:%s:%s:%s', p_department_id, p_week_start, p_close_at))
  from public.department_members dm
  join public.profiles p on p.id = dm.profile_id
  where dm.department_id = p_department_id and dm.removed_at is null and p.approval_status = 'approved';
end;
$$;

create or replace function public.week_phase_timestamps(p_settings public.department_settings, p_week_start date)
returns table(open_at timestamptz, close_at timestamptz, publish_at timestamptz)
language sql
stable
set search_path = public, pg_temp
as $$
  select o, c, greatest(p, c)
  from (select
    ((p_week_start - 7 + p_settings.open_dow) + p_settings.open_time) at time zone 'Asia/Jerusalem' as o,
    ((p_week_start - 7 + p_settings.close_dow) + p_settings.close_time) at time zone 'Asia/Jerusalem' as c,
    ((p_week_start - 7 + p_settings.publish_dow) + p_settings.publish_time) at time zone 'Asia/Jerusalem' as p) t;
$$;

create or replace function public.open_week(p_department_id uuid, p_week_start date)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  v_publish_at := greatest(((p_week_start - 7 + v_settings.publish_dow) + v_settings.publish_time) at time zone 'Asia/Jerusalem', v_close_at);

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
$$;
