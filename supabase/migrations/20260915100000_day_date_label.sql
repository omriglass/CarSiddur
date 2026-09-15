-- Every single date shown to members carries its weekday (owner dump 2026-09-14
-- evening, bug B4/A1): "16/9" alone forces a mental weekday lookup; the requested
-- format is "ד׳ 16.9" (`weekday_labels.short_he`, which already includes the geresh
-- U+05F3, + a leading-zero-free day.month). `day_date_label()` is the one SQL place
-- that renders it, so no caller hand-rolls `to_char(...,'DD/MM')` for a
-- user-facing date again.
--
-- REQ §13 (2026-09-14/15 owner dump); DATA_MODEL.md §3.11.

create or replace function public.day_date_label(_at timestamptz) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select public.weekday_short_label((_at at time zone 'Asia/Jerusalem')::date)
    || ' ' || to_char((_at at time zone 'Asia/Jerusalem')::date, 'FMDD.FMMM');
$$;

create or replace function public.day_date_label(_d date) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select public.weekday_short_label(_d) || ' ' || to_char(_d, 'FMDD.FMMM');
$$;

revoke execute on function public.day_date_label(timestamptz) from public, anon;
grant execute on function public.day_date_label(timestamptz) to authenticated;
revoke execute on function public.day_date_label(date) from public, anon;
grant execute on function public.day_date_label(date) to authenticated;

-- notification_context()'s `day` var: was a bare `to_char(dt,'DD/MM')`, now weekday +
-- date via day_date_label(). `date` (`DD/MM/YY`) is unchanged — copy the whole function
-- (20260907093700_fix_notification_interpolation.sql, the only/latest definition) and
-- change only that one line.
create or replace function public.notification_context(_recipient uuid,_department_id uuid,_week_start date,_data jsonb) returns jsonb
security definer stable set search_path = public, pg_temp language plpgsql as $$
declare q public.requests%rowtype; r public.rides%rowtype; pr public.proposals%rowtype; w public.weeks%rowtype;
  v jsonb; dt timestamptz; dest text; fullname text; carname text;
begin
  select * into w from public.weeks where department_id=_department_id and week_start=_week_start;
  select * into pr from public.proposals where id=nullif(_data->>'proposal_id','')::uuid;
  select * into q from public.requests where id=coalesce(nullif(_data->>'request_id','')::uuid,pr.request_id);
  select rd.* into r from public.rides rd where rd.id=coalesce(nullif(_data->>'ride_id','')::uuid,pr.ride_id,
    (select rr.ride_id from public.ride_requests rr join public.rides x on x.id=rr.ride_id where rr.request_id=q.id and x.status<>'cancelled' limit 1));
  select name into dest from public.destinations where id=q.destination_id;
  select full_name into fullname from public.profiles where id=coalesce(q.requester_id,_recipient);
  select name into carname from public.cars where id=r.car_id;
  dt:=coalesce(q.depart_at,q.return_at,r.starts_at);
  v:=jsonb_build_object('weekLabel',to_char(_week_start,'DD/MM/YY'),
    'closeTime',to_char(w.close_at at time zone 'Asia/Jerusalem','DD/MM HH24:MI'),
    'firstName',coalesce(fullname,''),'destination',coalesce(dest,q.destination_text,''),
    'date',to_char(dt at time zone 'Asia/Jerusalem','DD/MM/YY'),'day',public.day_date_label(dt),
    'depart',to_char(coalesce(r.starts_at,q.depart_at) at time zone 'Asia/Jerusalem','HH24:MI'),
    'return',to_char(coalesce(r.ends_at,q.return_at) at time zone 'Asia/Jerusalem','HH24:MI'),
    'car',coalesce(carname,''),'outcomeLine',coalesce(carname,dest,q.destination_text,''),
    'diffLine',concat_ws(' · ',carname,to_char(coalesce(r.starts_at,dt) at time zone 'Asia/Jerusalem','DD/MM HH24:MI')),
    'sadranName',(select full_name from public.profiles where id=pr.created_by),
    'proposalShort',pr.reason_he,'expiresAt',to_char(pr.expires_at at time zone 'Asia/Jerusalem','DD/MM HH24:MI'),
    'count',coalesce(_data->>'count',''),'email',(select email from public.profiles where id=_recipient));
  return v;
end $$;
revoke execute on function public.notification_context(uuid,uuid,date,jsonb) from public,anon,authenticated;

-- Repair already-persisted inbox text the same way 20260907093700 did, so old rows
-- render the new `day` format too (harmless no-op if none match).
alter table public.notifications disable trigger notifications_protect_fields;
update public.notifications n set
  title_he=public.render_notification_text(n.title_he,public.notification_context(n.recipient_id,n.department_id,n.week_start,n.data)),
  body_he=public.render_notification_text(n.body_he,public.notification_context(n.recipient_id,n.department_id,n.week_start,n.data))
where title_he like '%{{%' or body_he like '%{{%';
alter table public.notifications enable trigger notifications_protect_fields;

-- publish_siddur()'s grouped notification loop (20260910096000, further patched by
-- 20260910096300 for the `days_agg` weekday letters): the per-line `request_line` used
-- by `{{outcomeLine}}`/`{{diffLine}}` still rendered `line_dt` as a bare `DD/MM`. Patch
-- the live definition in place, same technique as the migrations above, to use
-- day_date_label() there too — the `days_agg` weekday-letters-only list is untouched.
do $migration$
declare
  def text;
  old_line text := $old$        concat_ws(' · ',
          to_char(line_dt at time zone 'Asia/Jerusalem','DD/MM') || ' ' ||
            to_char(line_depart at time zone 'Asia/Jerusalem','HH24:MI') || '–' ||
            to_char(line_return at time zone 'Asia/Jerusalem','HH24:MI'),
          nullif(line_place,'')
        ) as request_line$old$;
  new_line text := $new$        concat_ws(' · ',
          public.day_date_label(line_dt) || ' ' ||
            to_char(line_depart at time zone 'Asia/Jerusalem','HH24:MI') || '–' ||
            to_char(line_return at time zone 'Asia/Jerusalem','HH24:MI'),
          nullif(line_place,'')
        ) as request_line$new$;
begin
  def := pg_get_functiondef('public.publish_siddur(uuid,date,jsonb,text,jsonb,date[],boolean)'::regprocedure);
  if strpos(def, old_line) = 0 then raise exception 'unexpected_publish_siddur_request_line'; end if;
  def := replace(def, old_line, new_line);
  execute def;
end;
$migration$;

-- Admin-editable notification_templates: only refresh rows the admin never touched
-- (body still equals the seeded default_body), same convention as 20260910096100.
-- Seeded copy dropped the now-redundant " {{date}}" right after "{{day}}" (whatsapp
-- proposal_received variants), and the ride_change variant swapped "ב־{{date}}" for
-- "ב{{day}}" — see supabase/seed.sql.
update public.notification_templates
set body = 'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'ביקשת רכב ל{{destination}} ב{{day}}, {{depart}}–{{return}}.' || chr(10) ||
    'בשעות האלה אין רכב פנוי, אבל יש רכב אם יוצאים {{newDepart}} וחוזרים {{newReturn}}.' || chr(10) ||
    'מתאים? אפשר לאשר או לדחות כאן:' || chr(10) || '{{link}}',
  default_body = 'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'ביקשת רכב ל{{destination}} ב{{day}}, {{depart}}–{{return}}.' || chr(10) ||
    'בשעות האלה אין רכב פנוי, אבל יש רכב אם יוצאים {{newDepart}} וחוזרים {{newReturn}}.' || chr(10) ||
    'מתאים? אפשר לאשר או לדחות כאן:' || chr(10) || '{{link}}'
where event = 'proposal_received' and channel = 'whatsapp' and coalesce(variant, '') = 'shift'
  and body = 'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'ביקשת רכב ל{{destination}} ב{{day}} {{date}}, {{depart}}–{{return}}.' || chr(10) ||
    'בשעות האלה אין רכב פנוי, אבל יש רכב אם יוצאים {{newDepart}} וחוזרים {{newReturn}}.' || chr(10) ||
    'מתאים? אפשר לאשר או לדחות כאן:' || chr(10) || '{{link}}';

update public.notification_templates
set body = 'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'ביקשת רכב ל{{destination}} ב{{day}}.' || chr(10) ||
    '{{driverName}} נוסע/ת לשם באותו יום — יציאה {{newDepart}}, חזרה {{newReturn}} — ויש מקום ברכב.' || chr(10) ||
    'להצטרף לנסיעה כנוסע/ת? כך משתחרר רכב לחבר/ה אחר/ת.' || chr(10) ||
    'תשובה כאן:' || chr(10) || '{{link}}',
  default_body = 'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'ביקשת רכב ל{{destination}} ב{{day}}.' || chr(10) ||
    '{{driverName}} נוסע/ת לשם באותו יום — יציאה {{newDepart}}, חזרה {{newReturn}} — ויש מקום ברכב.' || chr(10) ||
    'להצטרף לנסיעה כנוסע/ת? כך משתחרר רכב לחבר/ה אחר/ת.' || chr(10) ||
    'תשובה כאן:' || chr(10) || '{{link}}'
where event = 'proposal_received' and channel = 'whatsapp' and coalesce(variant, '') = 'merge_passenger'
  and body = 'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'ביקשת רכב ל{{destination}} ב{{day}} {{date}}.' || chr(10) ||
    '{{driverName}} נוסע/ת לשם באותו יום — יציאה {{newDepart}}, חזרה {{newReturn}} — ויש מקום ברכב.' || chr(10) ||
    'להצטרף לנסיעה כנוסע/ת? כך משתחרר רכב לחבר/ה אחר/ת.' || chr(10) ||
    'תשובה כאן:' || chr(10) || '{{link}}';

update public.notification_templates
set body = 'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'בנסיעה שלך ל{{destination}} ב{{day}} ({{depart}}–{{return}}) יש מקום פנוי.' || chr(10) ||
    '{{passengerName}} צריך/ה להגיע לאותו אזור. אפשר לצרף? התוספת בדרך: כ-{{detourMin}} דק׳.' || chr(10) ||
    'תשובה כאן:' || chr(10) || '{{link}}',
  default_body = 'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'בנסיעה שלך ל{{destination}} ב{{day}} ({{depart}}–{{return}}) יש מקום פנוי.' || chr(10) ||
    '{{passengerName}} צריך/ה להגיע לאותו אזור. אפשר לצרף? התוספת בדרך: כ-{{detourMin}} דק׳.' || chr(10) ||
    'תשובה כאן:' || chr(10) || '{{link}}'
where event = 'proposal_received' and channel = 'whatsapp' and coalesce(variant, '') = 'merge_driver'
  and body = 'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'בנסיעה שלך ל{{destination}} ב{{day}} {{date}} ({{depart}}–{{return}}) יש מקום פנוי.' || chr(10) ||
    '{{passengerName}} צריך/ה להגיע לאותו אזור. אפשר לצרף? התוספת בדרך: כ-{{detourMin}} דק׳.' || chr(10) ||
    'תשובה כאן:' || chr(10) || '{{link}}';

update public.notification_templates
set body = 'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'לצערי לא הצלחנו לשבץ רכב ל{{destination}} ב{{day}} {{depart}}–{{return}}.' || chr(10) ||
    'הסיבה: {{reason}}.' || chr(10) ||
    'אם יתפנה רכב מתאים במהלך השבוע תקבל/י הודעה אוטומטית. פרטים ואפשרויות:' || chr(10) || '{{link}}',
  default_body = 'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'לצערי לא הצלחנו לשבץ רכב ל{{destination}} ב{{day}} {{depart}}–{{return}}.' || chr(10) ||
    'הסיבה: {{reason}}.' || chr(10) ||
    'אם יתפנה רכב מתאים במהלך השבוע תקבל/י הודעה אוטומטית. פרטים ואפשרויות:' || chr(10) || '{{link}}'
where event = 'proposal_received' and channel = 'whatsapp' and coalesce(variant, '') = 'deny'
  and body = 'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'לצערי לא הצלחנו לשבץ רכב ל{{destination}} ב{{day}} {{date}} {{depart}}–{{return}}.' || chr(10) ||
    'הסיבה: {{reason}}.' || chr(10) ||
    'אם יתפנה רכב מתאים במהלך השבוע תקבל/י הודעה אוטומטית. פרטים ואפשרויות:' || chr(10) || '{{link}}';

update public.notification_templates
set body = 'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'לצערי אין רכב פנוי ל{{destination}} ב{{day}} {{depart}}–{{return}}, גם לא עם הזזה.' || chr(10) ||
    'אפשר לענות כאן:' || chr(10) || '{{link}}' || chr(10) ||
    '(אסתדר/ת בעצמי, או להישאר ברשימת ההמתנה למקרה שיתפנה רכב)',
  default_body = 'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'לצערי אין רכב פנוי ל{{destination}} ב{{day}} {{depart}}–{{return}}, גם לא עם הזזה.' || chr(10) ||
    'אפשר לענות כאן:' || chr(10) || '{{link}}' || chr(10) ||
    '(אסתדר/ת בעצמי, או להישאר ברשימת ההמתנה למקרה שיתפנה רכב)'
where event = 'proposal_received' and channel = 'whatsapp' and coalesce(variant, '') = 'external'
  and body = 'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    'לצערי אין רכב פנוי ל{{destination}} ב{{day}} {{date}} {{depart}}–{{return}}, גם לא עם הזזה.' || chr(10) ||
    'אפשר לענות כאן:' || chr(10) || '{{link}}' || chr(10) ||
    '(אסתדר/ת בעצמי, או להישאר ברשימת ההמתנה למקרה שיתפנה רכב)';

update public.notification_templates
set body = 'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    '{{passengerName}} צריך/ה הסעה ל{{destination}} ב{{day}} סביב {{depart}} ({{driverName}} לא נוהג/ת בעצמו/ה הפעם).' || chr(10) ||
    'אפשר/י להסיע ולהחזיר את הרכב הביתה? זה ייקח כ-{{detourMin}} דק׳.' || chr(10) ||
    'תשובה כאן:' || chr(10) || '{{link}}',
  default_body = 'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    '{{passengerName}} צריך/ה הסעה ל{{destination}} ב{{day}} סביב {{depart}} ({{driverName}} לא נוהג/ת בעצמו/ה הפעם).' || chr(10) ||
    'אפשר/י להסיע ולהחזיר את הרכב הביתה? זה ייקח כ-{{detourMin}} דק׳.' || chr(10) ||
    'תשובה כאן:' || chr(10) || '{{link}}'
where event = 'proposal_received' and channel = 'whatsapp' and coalesce(variant, '') = 'chauffeur'
  and body = 'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
    '{{passengerName}} צריך/ה הסעה ל{{destination}} ב{{day}} {{date}} סביב {{depart}} ({{driverName}} לא נוהג/ת בעצמו/ה הפעם).' || chr(10) ||
    'אפשר/י להסיע ולהחזיר את הרכב הביתה? זה ייקח כ-{{detourMin}} דק׳.' || chr(10) ||
    'תשובה כאן:' || chr(10) || '{{link}}';

update public.notification_templates
set body = 'בקשה לרכב ב{{day}} {{depart}}–{{return}}. האם לאשר את ביטול הנסיעה שלך?',
  default_body = 'בקשה לרכב ב{{day}} {{depart}}–{{return}}. האם לאשר את ביטול הנסיעה שלך?'
where event = 'proposal_received' and channel in ('inbox', 'push') and coalesce(variant, '') = 'ride_change'
  and body = 'בקשה לרכב ב־{{date}} {{depart}}–{{return}}. האם לאשר את ביטול הנסיעה שלך?';
