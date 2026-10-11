-- Owner 2026-10-11 (REQ §13.125 f): "שליחת התראת בדיקה" in the profile. The member sends one notification to
-- themselves through the real pipeline (`enqueue_notification` → inbox row + one push_outbox row per subscribed device →
-- the push_outbox insert trigger dispatches right away), so a missing push really means the device is not reached.
-- Never muted (`member_mutable = false`, category `account`); the link is the default one (`/inbox`).

insert into public.notification_event_meta (event, category, member_mutable, sadran_role, week_scoped)
values ('test_notification', 'account', false, false, false)
on conflict (event) do nothing;

-- Default Hebrew copy, also in supabase/seed.sql for fresh/local/e2e databases.
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'test_notification'::public.notification_event, ch, null,
  'התראת בדיקה', 'אם ההודעה הזאת הגיעה, ההתראות מגיעות אליך.',
  'התראת בדיקה', 'אם ההודעה הזאת הגיעה, ההתראות מגיעות אליך.'
from unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do nothing;

-- Returns how many devices the push was queued for (0 = no device has notifications turned on).
create or replace function public.send_test_notification()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := (select auth.uid());
  v_devices int;
begin
  if v_me is null or not public.is_approved() then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  select count(*) into v_devices from public.push_subscriptions where profile_id = v_me;
  perform public.enqueue_notification(
    v_me, 'test_notification', (select default_department_id from public.profiles where id = v_me), null,
    '{}'::jsonb, '{}'::jsonb, format('test_notification:%s:%s', v_me, clock_timestamp()));
  return jsonb_build_object('devices', v_devices);
end;
$$;

revoke all on function public.send_test_notification() from public;
grant execute on function public.send_test_notification() to authenticated;
