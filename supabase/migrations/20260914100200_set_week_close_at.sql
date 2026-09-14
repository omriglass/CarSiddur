-- F2 (docs/TODO.md, owner answers A2-A4, 2026-09-14): Sadran-only "change this week's
-- request-closing time" action, reached from the board's kebab menu. `weeks.close_at`
-- already exists per week (materialize_department_weeks fills it from department_settings
-- defaults); this RPC lets a Sadran override it for one week, shortening or extending the
-- window as long as it stays within (open_at, publish_at] and on the 15-minute grid.
--
-- Phase bookkeeping mirrors advance_week_phases() (20260910098200_create_week_stats.sql):
-- that function flips `open` -> `solving` once `close_at <= now()` and notifies the
-- Sadranim `window_closed_solve_now` so they know to run the solver. If the Sadran's new
-- close_at lands in the past while the week is still `open`, this RPC performs the exact
-- same transition + notification here (same event, same recipients via sadranim_of(), same
-- payload shape) rather than waiting up to 15 minutes for the next `app.tick()`. Conversely,
-- extending close_at into the future while `solving` reopens the week for requests — there
-- is no such reverse transition anywhere else in the schema, so it is defined here.
--
-- Members always get a `window_changed` notice with the new closing day/time (owner
-- decision A2) regardless of whether the phase itself flips.
--
-- REQ §13.81; DATA_MODEL.md §3.11, §6; UX_FLOWS.md §4.2, §6.1.

create or replace function public.set_week_close_at(
  p_department_id uuid,
  p_week_start date,
  p_close_at timestamptz
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
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

  if p_close_at is null or p_close_at <= w.open_at or p_close_at > w.publish_at or not public.is_quarter_hour(p_close_at) then
    raise exception 'week_close_out_of_range';
  end if;

  v_new_phase := w.phase;
  if w.phase = 'solving' and p_close_at > now() then
    v_new_phase := 'open';
  elsif w.phase = 'open' and p_close_at <= now() then
    v_new_phase := 'solving';
  end if;

  perform set_config('app.audit_reason', 'set_week_close_at', true);
  update public.weeks set close_at = p_close_at, phase = v_new_phase
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

revoke execute on function public.set_week_close_at(uuid, date, timestamptz) from public, anon;
grant execute on function public.set_week_close_at(uuid, date, timestamptz) to authenticated;

-- notification_default_url(): window_changed is a member-facing window event like
-- window_open/window_closing (no 'sadran' variant), so it gets the same siddur deep link.
-- Reproduced verbatim from 20260910091600_extend_notification_default_url_waitlist.sql with
-- one addition to the event list.
create or replace function public.notification_default_url(
  _event public.notification_event,
  _data jsonb,
  _department_id uuid,
  _week_start date
) returns text
language plpgsql stable as $$
declare
  v_token text := nullif(_data ->> 'token', '');
  v_proposal_id uuid := nullif(_data ->> 'proposal_id', '')::uuid;
  v_ride_change_id uuid := nullif(_data ->> 'ride_change_id', '')::uuid;
  v_request_id uuid := coalesce(nullif(_data ->> 'request_id', '')::uuid, nullif(_data ->> 'offer_id', '')::uuid);
  v_ride_id uuid := nullif(_data ->> 'ride_id', '')::uuid;
  v_car_id uuid := nullif(_data ->> 'car_id', '')::uuid;
  v_group_id uuid := nullif(_data ->> 'group_id', '')::uuid;
  v_day text := nullif(_data ->> 'day', '');
  v_is_sadran_event boolean;
begin
  if v_token is not null then
    return '/p/' || v_token;
  end if;

  if v_proposal_id is not null and _department_id is not null and _week_start is not null then
    return format('/sadran/%s/%s/proposals?proposal=%s', _department_id, _week_start, v_proposal_id);
  end if;

  if v_group_id is not null and v_day is not null and _department_id is not null and _week_start is not null then
    return format('/siddur/%s/%s?day=%s&group=%s', _department_id, _week_start, v_day, v_group_id);
  end if;

  if v_ride_change_id is not null then
    return format('/inbox?change=%s', v_ride_change_id);
  end if;

  if v_request_id is not null then
    return format('/requests?focus=%s', v_request_id);
  end if;

  if v_ride_id is not null and _department_id is not null and _week_start is not null then
    return format('/siddur/%s/%s?ride=%s', _department_id, _week_start, v_ride_id);
  end if;

  if v_car_id is not null then
    return format('/cars/%s', v_car_id);
  end if;

  if _department_id is not null and _week_start is not null
    and _event in ('published', 'window_open', 'window_closing', 'window_closed_solve_now', 'publish_reminder', 'window_changed')
  then
    v_is_sadran_event := _event in ('window_closed_solve_now', 'publish_reminder')
      or (_event = 'window_open' and _data ->> 'variant' = 'sadran');
    if v_is_sadran_event then
      return format('/sadran/%s/%s', _department_id, _week_start);
    end if;
    return format('/siddur/%s/%s', _department_id, _week_start);
  end if;

  return '/inbox';
end;
$$;

revoke execute on function public.notification_default_url(public.notification_event, jsonb, uuid, date) from public, anon;
grant execute on function public.notification_default_url(public.notification_event, jsonb, uuid, date) to authenticated;

-- Hebrew copy (hard rule 3(c), seeded data): persisted here for hosted deployments that
-- don't load supabase/seed.sql (mirrors 20260910091700_waitlist_notification_templates.sql
-- and 20260909099600_car_care_notification_templates.sql); the same rows are added to
-- supabase/seed.sql for fresh local databases. Null-variant on both channels — required by
-- the "all production events need default templates" invariant (supabase/tests/status_notifications.sql).
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'window_changed'::public.notification_event, ch, null,
  'מועד סגירת הבקשות השתנה', 'הבקשות לשבוע {{weekLabel}} נסגרות ביום {{closeDay}} בשעה {{closeTime}}.',
  'מועד סגירת הבקשות השתנה', 'הבקשות לשבוע {{weekLabel}} נסגרות ביום {{closeDay}} בשעה {{closeTime}}.'
from unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do nothing;
