-- REQ §13.202 (owner 2026-11-09): the "my rides" option is now "הצגת נסיעות של אנשים שנתנו לי הרשאת עריכה";
-- the new editor's message quotes it. Only rows still at their default text change (an admin's own edit stays).
update public.notification_templates
set body = replace(body, '״הצגת נסיעות של מי שנתנו לי לערוך״', '״הצגת נסיעות של אנשים שנתנו לי הרשאת עריכה״'),
    default_body = replace(default_body, '״הצגת נסיעות של מי שנתנו לי לערוך״', '״הצגת נסיעות של אנשים שנתנו לי הרשאת עריכה״')
where event = 'ride_editor_added' and body = default_body;
