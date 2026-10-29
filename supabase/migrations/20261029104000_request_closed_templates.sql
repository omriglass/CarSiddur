-- REQ §13.162 (c): the member is told once that the Sadran closed their request ("הנסיעה כבר לא רלוונטית"), with the
-- Sadran's reason when one was given (`request_closed`) or without it (`request_closed_plain`). Not a placement outcome,
-- so it is sent on an unpublished day too (not in _notice_is_unpublished_outcome's list); on the board it is held for
-- "שלח את כל ההצעות" like every board change (REQ §13.138), except in a live week. restore_closed_request() deletes it.
insert into public.notification_templates(event,channel,variant,title,body,default_title,default_body)
select 'outcome_changed',channel,v.variant,v.title,v.body,v.title,v.body
from unnest(array['inbox','push']::public.notification_channel[]) channel
cross join (values
  ('request_closed',
   'הבקשה שלך נסגרה',
   '{{byName}} סימן/ה שהנסיעה שלך ביום {{day}} {{route}} כבר לא רלוונטית, והבקשה נסגרה. הסיבה: {{reason}}. הבקשה יצאה מרשימת ההמתנה ולא יוצע לה רכב. אם עדיין צריך נסיעה — אפשר להגיש בקשה חדשה.'),
  ('request_closed_plain',
   'הבקשה שלך נסגרה',
   '{{byName}} סימן/ה שהנסיעה שלך ביום {{day}} {{route}} כבר לא רלוונטית, והבקשה נסגרה. הבקשה יצאה מרשימת ההמתנה ולא יוצע לה רכב. אם עדיין צריך נסיעה — אפשר להגיש בקשה חדשה.')
) as v(variant, title, body)
on conflict (event,channel,(coalesce(variant,''))) do update set title=excluded.title,body=excluded.body,default_title=excluded.default_title,default_body=excluded.default_body;
