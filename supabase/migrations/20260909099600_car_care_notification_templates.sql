-- Car care portal: inbox + push copy for the `car_care` event, one variant per issue
-- category plus `tire_fill` and `wash` (owner decision 2026-09-09: per-category variants,
-- not a Hebrew category label inside a shared template — hard rule 3 forbids Hebrew in
-- SQL function bodies, and `notification_templates` is the seeded-data exception).
-- `supabase/seed.sql` gets the same rows for fresh databases; this migration is the
-- `on conflict do nothing` data migration for already-provisioned environments (this local
-- DB included), following `20260909098000_proposal_answered_variants.sql`'s pattern.
-- REQ §6 (car care); DATA_MODEL.md §3.11; UX_FLOWS.md §6.1.
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'car_care'::public.notification_event, ch, t.variant, t.title, t.body, t.title, t.body
from (values
  ('issue_warning_light', '{{byName}} דיווח/ה על אור אזהרה ברכב {{carName}}', '{{description}}'),
  ('issue_mechanical', '{{byName}} דיווח/ה על תקלה מכנית ברכב {{carName}}', '{{description}}'),
  ('issue_lighting', '{{byName}} דיווח/ה על תקלת תאורה ברכב {{carName}}', '{{description}}'),
  ('issue_physical_damage', '{{byName}} דיווח/ה על נזק לרכב {{carName}}', '{{description}}'),
  ('tire_fill', '{{byName}} מילא/ה אוויר בצמיגי {{carName}}', '{{lowCount}} צמיגים נמוכים, {{veryLowCount}} נמוכים מאוד'),
  ('wash', '{{byName}} שטף/ה את {{carName}}', '{{carName}} נקי/ה ומוכן/ה לנסיעה')
) as t(variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do nothing;

-- Defensive null-variant fallback (every emitter above always sets `_data.variant`, so this
-- row is not expected to render in practice) — required by `status_notifications.sql`'s
-- "all production events need default templates" assertion, same as `proposal_answered`'s.
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'car_care'::public.notification_event, ch, null,
  '{{byName}} עדכן/ה את {{carName}}', 'עדכון טיפול ברכב.',
  '{{byName}} עדכן/ה את {{carName}}', 'עדכון טיפול ברכב.'
from unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do nothing;
