-- REQ §13.93 "Display": seeded copy that said "ל{{destination}}" (home-only phrasing)
-- switches to the new `{{route}}` var (20261004130200_notification_context_route_vars.sql),
-- which renders "ל<dest>" when the request's origin is the department home and
-- "מ<origin> ל<dest>" otherwise. Scoped to the literal substring across every seeded row
-- (title/body/default_title/default_body, all channels and variants) -- bare `{{destination}}`
-- titles with no `ל` prefix (e.g. "הצעה מ{{sadranName}} לגבי {{destination}}") are untouched,
-- they are not direction phrases. Owner note: production has no data yet, so rewriting
-- seeded rows is fine (no back-compat concern).
update public.notification_templates
set title = replace(title, 'ל{{destination}}', '{{route}}'),
    body = replace(body, 'ל{{destination}}', '{{route}}'),
    default_title = replace(default_title, 'ל{{destination}}', '{{route}}'),
    default_body = replace(default_body, 'ל{{destination}}', '{{route}}')
where title like '%ל{{destination}}%' or body like '%ל{{destination}}%'
   or default_title like '%ל{{destination}}%' or default_body like '%ל{{destination}}%';
