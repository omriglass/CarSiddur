-- REQ §13.92 (owner 2026-09-24, A5) — default Hebrew copy for `car_swapped`, persisted here
-- for hosted deployments that don't load supabase/seed.sql (mirrors
-- 20260914100100_notification_event_window_changed.sql / 20260914100200_set_week_close_at.sql).
-- The same rows are added to supabase/seed.sql for fresh/local/e2e databases.
--
-- `{{day}}` already renders "ה׳ 17.9" via notification_context() (day_date_label());
-- `{{depart}}`/`{{return}}`/`{{car}}` (the NEW car) come from the same context. `{{fromCar}}`
-- is passed explicitly in `_vars` by swap_day_cars() (notification_context has no notion of
-- "the car this ride used to be on"). RTL-safe phrasing: "עברה מ-X ל-Y" instead of an X ← Y
-- dash construction.
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'car_swapped'::public.notification_event, ch, null,
  'הרכב שלך הוחלף', 'הנסיעה שלך ביום {{day}} {{depart}}–{{return}} עברה מ{{fromCar}} ל{{car}}.',
  'הרכב שלך הוחלף', 'הנסיעה שלך ביום {{day}} {{depart}}–{{return}} עברה מ{{fromCar}} ל{{car}}.'
from unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do nothing;
