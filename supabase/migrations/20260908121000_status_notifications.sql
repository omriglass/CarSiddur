-- Production defaults must ship in migrations: seed.sql is local/demo only.
-- Preserve all administrator-customized templates.
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select t.event::public.notification_event, ch, null, t.title, t.body, t.title, t.body
from (values
  ('window_open', 'הבקשות לשבוע {{weekLabel}} נפתחו', 'אפשר להגיש בקשות עד {{closeTime}}.'),
  ('window_closing', 'עוד {{count}} שעות לסגירת הבקשות', 'עדיין לא הגשת בקשה לשבוע {{weekLabel}}? זה הזמן.'),
  ('window_closed_solve_now', 'חלון הבקשות נסגר', 'השבוע {{weekLabel}} מוכן לשיבוץ.'),
  ('publish_reminder', 'תזכורת לפרסום הסידור', 'השבוע {{weekLabel}} עדיין לא פורסם.'),
  ('published', 'הסידור לשבוע {{weekLabel}} פורסם', '{{outcomeLine}}'),
  ('outcome_changed', 'שינוי בסידור שלך', '{{diffLine}}'),
  ('proposal_received', 'הצעה מהסדרן/ית לגבי {{destination}}', '{{sadranName}} מציע/ה {{proposalShort}}. לחצו לענות.'),
  ('proposal_answered', '{{firstName}} {{answerVerb}} את ההצעה', '{{destination}}, {{day}} — {{proposalShort}}'),
  ('freed_slot', 'התפנה רכב ל{{destination}}!', '{{car}}, {{day}} {{depart}}–{{return}}. עדיין רלוונטי? לחצו "אני עדיין רוצה".'),
  ('freed_slot_auto', 'שובצת לרכב שהתפנה', '{{car}}, {{day}} {{depart}}–{{return}} ל{{destination}}.'),
  ('claim_approved', 'הרכב שלך 🎉', 'הסדרן/ית אישר/ה: {{car}}, {{day}} {{depart}}–{{return}}.'),
  ('claim_declined', 'הרכב שהתפנה נמסר לאחר/ת', 'הבקשה ל{{destination}} נשארת ברשימת ההמתנה.'),
  ('claim_contested', '{{count}} חברים מבקשים את הרכב שהתפנה', '{{car}}, {{day}} {{depart}}–{{return}}. יש לבחור.'),
  ('maintenance_affects', '{{car}} נכנס/ת לטיפול', 'הנסיעה שלך ל{{destination}} ב{{day}} תשובץ מחדש; נעדכן בהקדם.'),
  ('late_request', 'בקשה מאוחרת מ{{firstName}}', '{{destination}}, {{day}} {{depart}}–{{return}} — התקבלה אחרי סגירת החלון.'),
  ('waitlisted_request', 'בקשה חדשה ללא רכב פנוי', '{{firstName}} — {{destination}}, {{day}} {{depart}}–{{return}}.'),
  ('auto_approved', 'הבקשה אושרה אוטומטית', '{{car}}, {{day}} {{depart}}–{{return}} ל{{destination}}.'),
  ('request_changed', '{{firstName}} שינה/תה בקשה', '{{destination}}, {{day}} — {{diffLine}}'),
  ('access_request', 'בקשת גישה חדשה', '{{email}} מבקש/ת להצטרף.'),
  ('access_approved', 'הגישה שלך אושרה', 'אפשר להיכנס לסידור הרכב של נבו.')
) as t(event, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do nothing;

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select event, channel, variant, null, body, null, body from (values
  ('proposal_received'::public.notification_event, 'whatsapp'::public.notification_channel, 'shift',
    'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'ביקשת רכב ל{{destination}} ב{{day}} {{date}}, {{depart}}–{{return}}.' || chr(10) ||
    'בשעות האלה אין רכב פנוי, אבל יש רכב אם יוצאים {{newDepart}} וחוזרים {{newReturn}}.' || chr(10) ||
    'מתאים? אפשר לאשר או לדחות כאן (עד {{expiresAt}}):' || chr(10) || '{{link}}'),
  ('proposal_received', 'whatsapp', 'merge_passenger',
    'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'ביקשת רכב ל{{destination}} ב{{day}} {{date}}.' || chr(10) ||
    '{{driverName}} נוסע/ת לשם באותו יום — יציאה {{newDepart}}, חזרה {{newReturn}} — ויש מקום ברכב.' || chr(10) ||
    'להצטרף לנסיעה כנוסע/ת? כך משתחרר רכב לחבר/ה אחר/ת.' || chr(10) ||
    'תשובה כאן (עד {{expiresAt}}):' || chr(10) || '{{link}}'),
  ('proposal_received', 'whatsapp', 'merge_driver',
    'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'בנסיעה שלך ל{{destination}} ב{{day}} {{date}} ({{depart}}–{{return}}) יש מקום פנוי.' || chr(10) ||
    '{{passengerName}} צריך/ה להגיע לאותו אזור. אפשר לצרף? התוספת בדרך: כ-{{detourMin}} דק׳.' || chr(10) ||
    'תשובה כאן (עד {{expiresAt}}):' || chr(10) || '{{link}}'),
  ('proposal_received', 'whatsapp', 'deny',
    'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'לצערי לא הצלחנו לשבץ רכב ל{{destination}} ב{{day}} {{date}} {{depart}}–{{return}}.' || chr(10) ||
    'הסיבה: {{reason}}.' || chr(10) ||
    'אם יתפנה רכב מתאים במהלך השבוע תקבל/י הודעה אוטומטית. פרטים ואפשרויות:' || chr(10) || '{{link}}'),
  -- Stage 3 hardening fix #4 (DATA_MODEL.md §6.1 item 19, UX_FLOWS.md §6.2 `wa.external` verbatim).
  ('proposal_received', 'whatsapp', 'external',
    'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'לצערי אין רכב פנוי ל{{destination}} ב{{day}} {{date}} {{depart}}–{{return}}, גם לא עם הזזה.' || chr(10) ||
    'אפשר לענות כאן (עד {{expiresAt}}):' || chr(10) || '{{link}}' || chr(10) ||
    '(אסתדר/ת בעצמי, או להישאר ברשימת ההמתנה למקרה שיתפנה רכב)'),
  -- Stage 3 hardening fix #4: `wa.chauffeur` verbatim (UX_FLOWS.md §6.2); no composer action
  -- wires it yet (UX_FLOWS.md §15 item 6, a separate recorded gap), but the row exists for
  -- whenever that UI ships.
  ('proposal_received', 'whatsapp', 'chauffeur',
    'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    '{{passengerName}} צריך/ה הסעה ל{{destination}} ב{{day}} {{date}} סביב {{depart}} ({{driverName}} לא נוהג/ת בעצמו/ה הפעם).' || chr(10) ||
    'אפשר/י להסיע ולהחזיר את הרכב הביתה? זה ייקח כ-{{detourMin}} דק׳.' || chr(10) ||
    'תשובה כאן (עד {{expiresAt}}):' || chr(10) || '{{link}}'),
  ('proposal_received', 'whatsapp', 'reminder',
    'היי {{firstName}}, תזכורת קטנה מ{{sadranName}} 🙂 ההצעה לגבי הנסיעה ל{{destination}} ב{{day}} מחכה לתשובה עד {{expiresAt}}: {{link}}')
) as w(event, channel, variant, body)
on conflict (event, channel, coalesce(variant, '')) do nothing;


-- Account and membership status messages. Copy is data; emitters select variants.
insert into public.notification_templates(event,channel,variant,title,body,default_title,default_body)
select 'status_changed', ch, t.variant, t.title, t.body, t.title, t.body
from (values
  (null::text, 'הסטטוס שלך עודכן', 'פרטי הגישה או התפקיד שלך עודכנו.'),
  ('pending', 'הגישה שלך ממתינה לאישור', 'החשבון שלך ממתין לאישור מנהל/ת.'),
  ('blocked', 'הגישה שלך נחסמה', 'לפנייה לגבי הגישה, יש ליצור קשר עם מנהל/ת המערכת.'),
  ('admin_granted', 'קיבלת הרשאות מנהל/ת', 'כעת אפשר לנהל את המערכת.'),
  ('admin_revoked', 'הרשאות הניהול שלך הוסרו', 'הרשאות מנהל/ת המערכת שלך הוסרו.'),
  ('sadran', 'מונית לסדרן/ית', 'התפקיד שלך במחלקת {{departmentName}} עודכן לסדרן/ית.'),
  ('member', 'התפקיד שלך עודכן לחבר/ה', 'התפקיד שלך במחלקת {{departmentName}} עודכן לחבר/ה.'),
  ('removed', 'החברות שלך במחלקה הוסרה', 'החברות שלך במחלקת {{departmentName}} הוסרה.')
) t(variant,title,body)
cross join unnest(array['inbox','push']::public.notification_channel[]) ch
on conflict (event,channel,(coalesce(variant,''))) do nothing;

-- Consent-based ride-change inbox and push messages.
insert into public.notification_templates(event,channel,variant,title,body,default_title,default_body)
select 'proposal_received',channel,'ride_change',
  '{{requesterName}} ביקש/ה לבטל את הנסיעה שלך',
  'בקשה לרכב ב־{{date}} {{depart}}–{{return}}. האם לאשר את ביטול הנסיעה שלך?',
  '{{requesterName}} ביקש/ה לבטל את הנסיעה שלך',
  'בקשה לרכב ב־{{date}} {{depart}}–{{return}}. האם לאשר את ביטול הנסיעה שלך?'
from unnest(array['inbox','push']::public.notification_channel[]) channel
on conflict (event,channel,(coalesce(variant,''))) do nothing;

create or replace function public.enqueue_notification(
  _recipient uuid,
  _event public.notification_event,
  _department_id uuid,
  _week_start date,
  _vars jsonb default '{}',
  _data jsonb default '{}',
  _dedupe_key text default null
) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_muted boolean;
  v_is_sadran_role_event boolean;
  v_bypass_mute boolean := false;
  v_inbox_title text; v_inbox_body text;
  v_push_title text; v_push_body text;
  v_notification_id uuid;
  v_sub record;
begin
  if _event = 'auto_approved' then return null; end if;
  _vars := public.notification_context(_recipient,_department_id,_week_start,_data) || coalesce(_vars,'{}'::jsonb);
  select coalesce(_event = any(p.muted_events), false) into v_muted from public.profiles p where p.id = _recipient;

  if v_muted and _event not in ('status_changed','access_request','access_approved') then
    v_is_sadran_role_event := _event in ('window_closed_solve_now','publish_reminder','proposal_answered',
      'claim_contested','late_request','waitlisted_request','request_changed','auto_approved')
      or (_event='window_open' and _data->>'variant'='sadran');
    if v_is_sadran_role_event and _department_id is not null and _week_start is not null then
      select exists (select 1 from public.sadranim_of(_department_id, _week_start) s where s = _recipient)
        into v_bypass_mute;
    end if;
    if not v_bypass_mute then
      return null;
    end if;
  end if;

  select title, body into v_inbox_title, v_inbox_body from public.notification_templates
  where event = _event and channel = 'inbox' and variant is not distinct from coalesce(_data->>'variant',case when _data ? 'ride_change_id' then 'ride_change' else null end);
  select title, body into v_push_title, v_push_body from public.notification_templates
  where event = _event and channel = 'push' and variant is not distinct from coalesce(_data->>'variant',case when _data ? 'ride_change_id' then 'ride_change' else null end);

  if v_inbox_body is null then
    select title,body into v_inbox_title,v_inbox_body from public.notification_templates
      where event=_event and channel='inbox' and variant is null;
  end if;
  if v_push_body is null then
    select title,body into v_push_title,v_push_body from public.notification_templates
      where event=_event and channel='push' and variant is null;
  end if;

  insert into public.notifications (recipient_id, department_id, week_start, event, title_he, body_he, data, dedupe_key)
  values (_recipient, _department_id, _week_start, _event,
          public.render_notification_text(v_inbox_title, _vars),
          public.render_notification_text(v_inbox_body, _vars),
          coalesce(_data, '{}'), _dedupe_key)
  on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing
  returning id into v_notification_id;

  if v_notification_id is null then
    return null;   -- deduped
  end if;

  for v_sub in select id from public.push_subscriptions where profile_id = _recipient loop
    insert into public.push_outbox (notification_id, subscription_id, payload)
    values (v_notification_id, v_sub.id, jsonb_build_object(
      'title', public.render_notification_text(coalesce(v_push_title, v_inbox_title), _vars),
      'body', public.render_notification_text(coalesce(v_push_body, v_inbox_body), _vars),
      'url', _data ->> 'url',
      'tag', _dedupe_key
    ));
  end loop;

  return v_notification_id;
end;
$$;


-- Table triggers cover both admin RPCs and direct authorized updates.
create function public.notify_profile_status_changed() returns trigger
security definer set search_path = public, pg_temp language plpgsql as $$
declare administrator uuid;
begin
  if new.approval_status is distinct from old.approval_status then
    if new.approval_status='approved' then
      perform public.enqueue_notification(new.id,'access_approved',null,null,'{}',jsonb_build_object('url','/'));
    else
      perform public.enqueue_notification(new.id,'status_changed',null,null,'{}',
        jsonb_build_object('variant',new.approval_status::text,'url','/pending'));
      if new.approval_status='pending' then
        for administrator in select id from public.profiles where is_admin and approval_status='approved' loop
          perform public.enqueue_notification(administrator,'access_request',null,null,
            jsonb_build_object('email',new.email),jsonb_build_object('url','/admin/members','profile_id',new.id));
        end loop;
      end if;
    end if;
  end if;
  if new.is_admin is distinct from old.is_admin then
    perform public.enqueue_notification(new.id,'status_changed',null,null,'{}',
      jsonb_build_object('variant',case when new.is_admin then 'admin_granted' else 'admin_revoked' end,
        'url',case when new.is_admin and new.approval_status='approved' then '/admin' else '/' end));
  end if;
  return new;
end $$;
revoke execute on function public.notify_profile_status_changed() from public,anon,authenticated;
create trigger notify_profile_status_changed after update of approval_status,is_admin on public.profiles
for each row execute function public.notify_profile_status_changed();

create function public.notify_department_member_status_changed() returns trigger
security definer set search_path = public, pg_temp language plpgsql as $$
declare member_row public.department_members%rowtype; variant text; department_name text;
begin
  if tg_op='DELETE' then
    member_row:=old; variant:='removed';
  else
    member_row:=new;
    if tg_op='UPDATE' then
      if old.role is not distinct from new.role and (old.removed_at is null)=(new.removed_at is null) then return new; end if;
    end if;
    variant:=case when new.removed_at is not null then 'removed' else new.role::text end;
  end if;
  -- Cascading account/department deletion has no remaining recipient/context.
  if not exists(select 1 from public.profiles where id=member_row.profile_id) then return null; end if;
  select name into department_name from public.departments where id=member_row.department_id;
  if not found then return null; end if;
  perform public.enqueue_notification(member_row.profile_id,'status_changed',member_row.department_id,null,
    jsonb_build_object('departmentName',department_name),
    jsonb_build_object('variant',variant,'url','/profile','department_id',member_row.department_id));
  return null;
end $$;
revoke execute on function public.notify_department_member_status_changed() from public,anon,authenticated;
create trigger notify_department_member_status_changed after insert or update or delete on public.department_members
for each row execute function public.notify_department_member_status_changed();

-- Existing sign-ups already enqueue access_request; make their payload actionable.
create or replace function public.handle_new_user() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_invite record;
  v_email text := lower(trim(coalesce(new.email, '')));
  v_profile_id uuid;
  v_admin_id uuid;
begin
  select * into v_invite from public.member_invites where email = v_email and consumed_at is null limit 1;

  insert into public.profiles (id, email, full_name, phone, approval_status, default_department_id, approved_at)
  values (
    new.id, v_email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''),
    v_invite.phone,
    case when v_invite.id is not null then 'approved'::public.approval_status else 'pending'::public.approval_status end,
    v_invite.department_id,
    case when v_invite.id is not null then now() else null end
  )
  returning id into v_profile_id;

  if v_invite.id is not null then
    update public.member_invites set consumed_at = now() where id = v_invite.id;
    insert into public.department_members (department_id, profile_id, role)
    values (v_invite.department_id, v_profile_id, coalesce(v_invite.role, 'member'))
    on conflict (department_id, profile_id) do nothing;
  else
    -- Hebrew copy lives only in notification_templates (hard rule 3); enqueue_notification
    -- is defined later (20260907091200_notifications.sql) but resolved at call time.
    for v_admin_id in select id from public.profiles where is_admin and approval_status='approved' loop
      perform public.enqueue_notification(v_admin_id, 'access_request', null, null,
        jsonb_build_object('email', v_email), jsonb_build_object('email', v_email,'profile_id',v_profile_id,'url','/admin/members'),
        format('access_request:%s', v_email));
    end loop;
  end if;

  return new;
end;
$$;

-- Repair blank historical inbox messages from deployments without seeded templates.
-- Keep non-empty custom/history copy intact; repair approval navigation as well.
alter table public.notifications disable trigger notifications_protect_fields;
update public.notifications n set
  title_he=case when n.title_he='' then public.render_notification_text(t.title,
    public.notification_context(n.recipient_id,n.department_id,n.week_start,n.data)||n.data) else n.title_he end,
  body_he=case when n.body_he='' then public.render_notification_text(t.body,
    public.notification_context(n.recipient_id,n.department_id,n.week_start,n.data)||n.data) else n.body_he end,
  data=case when n.event='access_request' and not (n.data ? 'url') then n.data||jsonb_build_object('url','/admin/members') else n.data end
from public.notification_templates t
where t.event=n.event and t.channel='inbox' and t.variant is null
  and (n.title_he='' or n.body_he='' or (n.event='access_request' and not(n.data ? 'url')));
alter table public.notifications enable trigger notifications_protect_fields;
