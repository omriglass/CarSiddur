-- R13U8 (QA run 13): the origin proposal's push/inbox body ("מחיפה לגבעת חביבה · … · במקום מחיפה") never named the new
-- starting place — only the title did, and the inbox list and the QA CLI show the body. The body now says it.
update public.notification_templates
set body = '{{route}} · {{day}} · יציאה מ{{newOrigin}} במקום מ{{originOrHome}} · {{car}}', updated_at = now()
where event = 'proposal_received' and variant = 'origin' and channel in ('push', 'inbox');

update public.notification_templates
set body = '{{route}} · {{day}} · יציאה מ{{newOrigin}} · {{car}}', updated_at = now()
where event = 'proposal_received' and variant = 'origin_placed' and channel in ('push', 'inbox');
