-- REQ §13.93: the `origin` WhatsApp proposal template named the current origin twice once
-- 20261004130300 swept `ל{{destination}}` to `{{route}}` (the route already says "מ<origin>"
-- when the origin is not home, and the next line names it again). Drop the redundant clause.
-- Mirrored in supabase/seed.sql.
update public.notification_templates
set body = replace(body, 'ביום {{day}}, יציאה מ{{origin}}.', 'ביום {{day}}.')
where event = 'proposal_received' and channel = 'whatsapp' and variant = 'origin';
