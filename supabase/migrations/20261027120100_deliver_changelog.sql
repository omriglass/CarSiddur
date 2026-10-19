-- REQ §13.139 (b): the app delivers a release's "מה חדש" message to the signed-in member's own inbox the first time they
-- open that version. The text comes from the app (src/i18n/he.changelog.ts, filtered to the reader's roles); this only
-- stores it: one `notifications` row for the caller, deduplicated per entry, and NO push_outbox row (a quiet message).
-- Never muted (`member_mutable = false`, category `account`); its link is `/changelog`.

insert into public.notification_event_meta (event, category, member_mutable, sadran_role, week_scoped)
values ('changelog', 'account', false, false, false)
on conflict (event) do nothing;

-- Returns true when the message was added, false when this entry was already delivered to the caller.
create or replace function public.deliver_changelog(p_entry_id text, p_title text, p_body text)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_me uuid := (select auth.uid());
  v_id uuid;
begin
  if v_me is null or not public.is_approved() then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_entry_id is null or p_entry_id !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
     or nullif(btrim(p_title), '') is null or length(p_title) > 200
     or nullif(btrim(p_body), '') is null or length(p_body) > 4000 then
    raise exception 'invalid_changelog' using errcode = 'P0001';
  end if;
  insert into public.notifications (recipient_id, department_id, week_start, event, title_he, body_he, data, dedupe_key)
  values (v_me, (select default_department_id from public.profiles where id = v_me), null, 'changelog', btrim(p_title), btrim(p_body),
    jsonb_build_object('url', '/changelog', 'entry', p_entry_id), 'changelog:' || p_entry_id)
  on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing
  returning id into v_id;
  return v_id is not null;
end $$;

revoke all on function public.deliver_changelog(text, text, text) from public, anon;
grant execute on function public.deliver_changelog(text, text, text) to authenticated;

-- Every event has default templates (status_notifications.sql). A changelog's real title and text come from the app
-- (deliver_changelog's arguments); these defaults only describe the event in the admin template editor.
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'changelog'::public.notification_event, ch, null, 'מה חדש', 'מה השתנה בגרסה החדשה של האפליקציה.', 'מה חדש', 'מה השתנה בגרסה החדשה של האפליקציה.'
from unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do nothing;
