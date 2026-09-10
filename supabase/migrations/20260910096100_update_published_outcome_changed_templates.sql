-- `published`/`outcome_changed` copy gains a `{{days}}` placeholder now that
-- publish_siddur() enqueues at most one of each per recipient per publish call, listing
-- every affected day (20260910096000_group_publish_notifications_by_recipient.sql). Body
-- text is unchanged (still `{{outcomeLine}}`/`{{diffLine}}`, now multi-line); only the
-- title changes. Preserve admin customizations: only overwrite `title`/`body` where they
-- still equal the previous seeded `default_title`/`default_body`; always refresh the
-- `default_title`/`default_body` snapshot so "restore default" offers the new copy.
-- REQ §9; DATA_MODEL.md §3.11.
update public.notification_templates
set title = case when title = default_title then 'הסידור פורסם לימים {{days}}' else title end,
    body = case when body = default_body then '{{outcomeLine}}' else body end,
    default_title = 'הסידור פורסם לימים {{days}}',
    default_body = '{{outcomeLine}}'
where event = 'published' and variant is null;

update public.notification_templates
set title = case when title = default_title then 'שינוי בסידור שלך לימים {{days}}' else title end,
    body = case when body = default_body then '{{diffLine}}' else body end,
    default_title = 'שינוי בסידור שלך לימים {{days}}',
    default_body = '{{diffLine}}'
where event = 'outcome_changed' and variant is null;
