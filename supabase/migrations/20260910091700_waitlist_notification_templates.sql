-- Contested waiting-list groups, part 6: inbox + push copy for `waitlist_contested` and
-- `waitlist_resolved`. `supabase/seed.sql` carries the same rows for fresh databases; this
-- migration is the `on conflict do nothing` data migration for already-provisioned
-- environments, following 20260909099600_car_care_notification_templates.sql.
-- Hebrew lives here (seeded data) and nowhere in the function bodies — hard rule 3.
-- The null-variant rows are mandatory: `supabase/tests/status_notifications.sql` asserts
-- every enum value has a default template on every channel.
-- REQ §7.3; DATA_MODEL.md §3.11; UX_FLOWS.md §6.1.

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'waitlist_contested'::public.notification_event, ch, t.variant, t.title, t.body, t.title, t.body
from (values
  (null, 'רשימת המתנה משותפת ליום {{day}}',
         'גם {{names}} מבקשים/ות רכב בשעות חופפות ({{depart}}–{{return}}). אפשר להסתדר ביניכם/ן ולסמן מי נוסע/ת — או שהסדרן/ית יחליט/ו.'),
  ('joined', '{{newName}} הצטרף/ה לדיון על הרכב ביום {{day}}',
         'בדיון עכשיו: {{names}}. השעות {{depart}}–{{return}}. אפשר לסמן מי נוסע/ת.'),
  ('sadran', 'דיון על רכב ביום {{day}}',
         '{{count}} בקשות חופפות ({{depart}}–{{return}}): {{names}}. החברים/ות יכולים/ות לסמן מי נוסע/ת, ואפשר גם להכריע במקומם/ן.')
) as t(variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do nothing;

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'waitlist_resolved'::public.notification_event, ch, t.variant, t.title, t.body, t.title, t.body
from (values
  (null, 'רשימת ההמתנה ליום {{day}} הוסדרה',
         '{{names}} נוסעים/ות ב{{depart}}–{{return}}.'),
  ('driver', 'הרכב שלך ליום {{day}}',
         '{{car}}, {{depart}}–{{return}}. את/ה הנהג/ת. נוסעים/ות: {{names}}.'),
  ('passenger', 'שובצת כנוסע/ת ליום {{day}}',
         '{{car}} עם {{driverName}}, {{depart}}–{{return}}.'),
  ('not_chosen', 'הדיון על הרכב ליום {{day}} הוכרע',
         '{{names}} נוסעים/ות הפעם. הבקשה שלך נשארת ברשימת ההמתנה.'),
  ('sadran', 'דיון הרכב ליום {{day}} הוסדר',
         '{{car}} עם {{driverName}} ({{depart}}–{{return}}). נוסעים/ות: {{names}}.'),
  ('cancelled', 'הדיון על הרכב ליום {{day}} נסגר',
         'לא נמצא פתרון משותף. הבקשות נשארות ברשימת ההמתנה.')
) as t(variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do nothing;
