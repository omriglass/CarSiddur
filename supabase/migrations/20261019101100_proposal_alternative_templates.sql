-- REQ §13.112 (a): copy for the plan-B (`alternative`) proposal, per reader (REQ §13.101, docs/COPY_DRAFT_2026-10.md):
-- the requester gets "no car to {{destination}} -- a הקפצה to {{dropPlace}} by {{dropTime}}{{pickupLine}} works?";
-- WhatsApp opens "היי X, אני פונה אליך בכובע של הסידור". `pickupLine` comes from text_fragments `alt.pickup` (empty
-- without a pickup). After an accepted plan B the member gets `outcome_changed` / `alternative_applied`.
-- Production defaults ship in migrations (seed.sql repeats them for a fresh local database; upserts, so order does not matter).
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select t.event::public.notification_event, ch.channel::public.notification_channel, t.variant, t.title, t.body, t.title, t.body
from (values
  ('proposal_received', 'alternative', 'תוכנית ב׳: הקפצה ל{{dropPlace}}', '{{destinationRoute}} · {{day}} · עד {{dropTime}}{{pickupLine}}'),
  ('outcome_changed',   'alternative_applied', 'שובצת בתוכנית ב׳', '{{day}} · {{planLine}}')
) as t(event, variant, title, body)
cross join (values ('inbox'), ('push')) as ch(channel)
on conflict (event, channel, (coalesce(variant, ''))) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title,
      default_body = excluded.default_body, updated_at = now();

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'proposal_received', 'whatsapp', t.variant, null, t.body, null, t.body
from (values
  ('alternative', $b$היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗
אין רכב {{destinationRoute}} ביום {{day}}. אפשר הקפצה ל{{dropPlace}} עד {{dropTime}}{{pickupLine}} (תוכנית ב׳ שרשמת). מתאים/ה?
{{link}}$b$)
) as t(variant, body)
on conflict (event, channel, (coalesce(variant, ''))) do update
  set body = excluded.body, default_body = excluded.default_body, updated_at = now();
