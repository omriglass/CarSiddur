-- REQ §13.101 b / docs/COPY_DRAFT_2026-10.md (owner-approved): proposal and outcome-change copy per reader.
--  * proposal_received push/inbox: one variant per reader (variables from proposal_reader_vars()); the whole
--    WhatsApp text (`proposalShort`) is no longer embedded.
--  * proposal_received whatsapp: opens "היי X, אני פונה אליך בכובע של הסידור" (the Sadran is never introduced);
--    external has exactly two variants (no car in your town / every car taken), no own-car variant.
--  * outcome_changed: time_changed, car_changed, merged, joined_ride, passenger_left, trip_type_changed.
-- Upserts (not updates) so a fresh `db reset` gets them before seed.sql's `on conflict do nothing` rows.
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select t.event::public.notification_event, ch.channel::public.notification_channel, t.variant, t.title, t.body, t.title, t.body
from (values
  ('proposal_received', null,              'הצעה לגבי {{route}}', '{{day}} · יש הצעה שמחכה לתשובה שלך'),
  ('proposal_received', 'shift',           'הצעה: להזיז את הנסיעה {{route}}', '{{day}} · {{timeChange}}{{carLine}}'),
  ('proposal_received', 'merge_passenger', 'הצעה: להצטרף לנסיעה של {{driverName}}', '{{route}} · {{day}} · {{joinLine}}'),
  ('proposal_received', 'merge_passenger_no_driver', 'הצעה: להצטרף לנסיעה {{route}}', '{{day}} · {{joinLine}} · הנסיעה עוד מחפשת נהג/ת'),
  ('proposal_received', 'merge_host',      '{{joinerName}} מבקש/ת להצטרף אליך', '{{route}} · {{day}} · {{timeChange}}{{detourLine}}'),
  ('proposal_received', 'merge_other',     '{{joinerName}} מבקש/ת להצטרף לנסיעה שלך', '{{route}} · {{day}} · {{timeChange}}'),
  ('proposal_received', 'external_city',   'אין רכב ב{{city}} ביום {{day}}', '{{route}} · {{timeRange}} · לאשר להסתדר, או להישאר בהמתנה'),
  ('proposal_received', 'external_none',   'אין רכב פנוי {{route}}', '{{day}} {{timeRange}} · להסתדר בעצמך או להישאר בהמתנה'),
  ('proposal_received', 'deny',            'לא נמצא רכב {{route}}', '{{day}} {{timeRange}} · {{reasonLine}}'),
  ('proposal_received', 'origin',          'הצעה: לצאת מ{{newOrigin}}', '{{route}} · {{day}} · {{car}} · במקום מ{{originOrHome}}'),
  ('outcome_changed',   'time_changed',    '{{byName}} שינה/תה שעות', '{{route}} · {{day}} · {{timeChange}}{{carLine}}'),
  ('outcome_changed',   'car_changed',     'הרכב שלך הוחלף', '{{route}} · {{day}} {{timeRange}} · {{changeLine}}'),
  ('outcome_changed',   'merged',          'שובצת כנוסע/ת {{route}}', '{{day}} · {{car}} עם {{driverName}} · {{joinLine}}'),
  ('outcome_changed',   'merged_no_driver', 'שובצת כנוסע/ת {{route}}', '{{day}} · {{car}} · {{joinLine}} · הנסיעה עוד מחפשת נהג/ת'),
  ('outcome_changed',   'joined_ride',     '{{joinerName}} מצטרף/ת לנסיעה שלך', '{{route}} · {{day}} · {{timeChange}}'),
  ('outcome_changed',   'passenger_left',  '{{names}} לא נוסע/ת איתך יותר', '{{route}} · {{day}} · {{timeChange}}'),
  ('outcome_changed',   'trip_type_changed', 'סוג הנסיעה שונה', '{{route}} · {{day}} · עכשיו: {{tripType}}')
) as t(event, variant, title, body)
cross join (values ('inbox'), ('push')) as ch(channel)
on conflict (event, channel, (coalesce(variant, ''))) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title,
      default_body = excluded.default_body, updated_at = now();

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'proposal_received', 'whatsapp', t.variant, null, t.body, null, t.body
from (values
  ('shift',
   E'היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗\n{{route}} ביום {{day}}: אפשר לשבץ אותך אם מזיזים — {{timeChange}}{{carLine}}.\nמתאים/ה? אפשר לאשר או לדחות כאן:\n{{link}}'),
  ('merge_passenger',
   E'היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗\nבמקום רכב נפרד: להצטרף כנוסע/ת אל {{driverName}} ({{car}}) {{route}} ביום {{day}}.\n{{joinLine}} — {{timeChange}}.\nמתאים/ה? תשובה כאן:\n{{link}}'),
  ('merge_passenger_no_driver',
   E'היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗\nבמקום רכב נפרד: להצטרף לנסיעה {{route}} ביום {{day}} ({{car}}), שעוד מחפשת נהג/ת.\n{{joinLine}} — {{timeChange}}.\nמתאים/ה? תשובה כאן:\n{{link}}'),
  ('merge_driver',
   E'היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗\n{{joinerName}} מבקש/ת להצטרף לנסיעה שלך {{route}} ביום {{day}}.\n{{timeChange}}{{detourLine}}.\nמתאים/ה? תשובה כאן:\n{{link}}'),
  ('merge_other',
   E'היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗\n{{joinerName}} מבקש/ת להצטרף לנסיעה שלך {{route}} ביום {{day}}.\n{{timeChange}}.\nמתאים/ה? תשובה כאן:\n{{link}}'),
  ('external_city',
   E'היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗\nאין כרגע רכב ב{{city}} {{route}} ביום {{day}} {{depart}}–{{return}}.\nאפשר להגיע לקיבוץ בעצמך ולצאת משם, או להישאר ברשימת ההמתנה. תשובה כאן:\n{{link}}'),
  ('external_none',
   E'היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗\nלצערי כל הרכבים תפוסים {{route}} ביום {{day}} {{depart}}–{{return}}, גם עם הזזה.\n{{externalSuggestion}} אם יתפנה רכב נעדכן אותך אוטומטית. תשובה כאן:\n{{link}}'),
  ('external',
   E'היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗\nלצערי כל הרכבים תפוסים {{route}} ביום {{day}} {{depart}}–{{return}}, גם עם הזזה.\n{{externalSuggestion}} אם יתפנה רכב נעדכן אותך אוטומטית. תשובה כאן:\n{{link}}'),
  ('deny',
   E'היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗\nלא הצלחנו לשבץ רכב {{route}} ביום {{day}} {{depart}}–{{return}}.\n{{reasonLine}}\nאם יתפנה רכב נעדכן אותך אוטומטית. פרטים:\n{{link}}'),
  ('origin',
   E'היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗\n{{route}} ביום {{day}}: אין רכב ב{{originOrHome}}, אבל {{car}} פנוי ב{{newOrigin}}.\nנקודת היציאה משתנה ל{{newOrigin}} (מ{{originOrHome}}), השעות נשארות {{depart}}–{{return}}. מתאים/ה?\n{{link}}'),
  ('chauffeur',
   E'היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗\n{{passengerName}} צריך/ה הסעה {{route}} ביום {{day}} סביב {{depart}} ({{driverName}} לא נוהג/ת בעצמו/ה הפעם).\nאפשר/י להסיע ולהחזיר את הרכב הביתה? זה ייקח כ-{{detourMin}} דק׳.\nתשובה כאן:\n{{link}}'),
  ('reminder',
   'היי {{firstName}}, תזכורת קטנה 🙂 ההצעה לגבי הנסיעה {{route}} ביום {{day}} מחכה לתשובה: {{link}}')
) as t(variant, body)
on conflict (event, channel, (coalesce(variant, ''))) do update
  set body = excluded.body, default_body = excluded.default_body, updated_at = now();

-- Contested-group wording: the Sadran decides, singular ("יחליט/ה", not "יחליט/ו"). These rows are
-- created by migrations (20260910091700, 20261006200200), so they exist when this runs.
update public.notification_templates
set body = replace(body, 'יחליט/ו', 'יחליט/ה'), default_body = replace(default_body, 'יחליט/ו', 'יחליט/ה')
where event = 'waitlist_contested' and body like '%יחליט/ו%';
