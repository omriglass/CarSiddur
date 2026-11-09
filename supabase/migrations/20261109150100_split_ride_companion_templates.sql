-- Owner 2026-11-09: the passenger split off into a request of their own (split_ride_companion) is told so
-- (same rows in supabase/seed.sql).
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select t.event::public.notification_event, ch, t.variant, t.title, t.body, t.title, t.body
from (values
  ('outcome_changed', 'companion_split', 'יש לך בקשה משלך',
   '{{byName}} העביר/ה אותך מהנסיעה {{route}} ביום {{day}} לבקשה משלך באותן שעות. היא מחכה לשיבוץ.')
) as t(event, variant, title, body)
cross join unnest(array['inbox','push']::public.notification_channel[]) as ch
on conflict (event,channel,(coalesce(variant,''))) do nothing;
