-- Proposals no longer expire on a timer (20260910090000_expire_proposals_on_day_publication.sql):
-- `expires_at` stays null, so the "(עד {{expiresAt}})" fragment in the seeded whatsapp
-- proposal_received/reminder templates now renders empty. Clean up the already-provisioned
-- rows in place with a targeted `replace()` so any admin customization that kept the
-- fragment is also fixed, while other admin edits to these bodies are left untouched.
-- REQ §13.29; DATA_MODEL §3.11.

update public.notification_templates
set body = replace(body, ' (עד {{expiresAt}})', '')
where event = 'proposal_received'
  and channel = 'whatsapp'
  and variant in ('shift', 'merge_passenger', 'merge_driver', 'external', 'chauffeur')
  and body like '% (עד {{expiresAt}})%';

update public.notification_templates
set body = replace(body, 'מחכה לתשובה עד {{expiresAt}}: {{link}}', 'מחכה לתשובה: {{link}}')
where event = 'proposal_received'
  and channel = 'whatsapp'
  and variant = 'reminder'
  and body like '%מחכה לתשובה עד {{expiresAt}}: {{link}}%';
