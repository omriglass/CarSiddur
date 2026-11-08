-- REQ §13.203 (c): what the asked driver and the requester read. `ride_change` (give the ride up) now says it was agreed
-- and renders the vars the emitter really passes ({{day}}, {{timeRange}}).
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select t.event::public.notification_event, ch, t.variant, t.title, t.body, t.title, t.body
from (values
  ('proposal_received', 'ride_shorten_end', '{{requesterName}}: לחזור ב־{{newTime}}?',
   'כפי שסיכמתם: ביום {{day}} חזרה ב־{{newTime}} במקום {{oldTime}} ({{minutes}} דק׳ מוקדם יותר), כדי לפנות את הרכב לנסיעה של {{requesterName}}.'),
  ('proposal_received', 'ride_shorten_start', '{{requesterName}}: לצאת ב־{{newTime}}?',
   'כפי שסיכמתם: ביום {{day}} יציאה ב־{{newTime}} במקום {{oldTime}} ({{minutes}} דק׳ מאוחר יותר), כדי לפנות את הרכב לנסיעה של {{requesterName}}.'),
  ('proposal_received', 'ride_change', '{{requesterName}}: לוותר על הנסיעה שלך?',
   'כפי שסיכמתם: הנסיעה שלך ביום {{day}} {{timeRange}} תתבטל, והרכב יעבור לנסיעה של {{requesterName}}.'),
  ('outcome_changed', 'ride_shorten_accepted', '{{partyName}} אישר/ה — הנסיעה שלך נקבעה',
   'ביום {{day}} {{timeRange}} ברכב {{car}}.'),
  ('outcome_changed', 'ride_shorten_declined', '{{partyName}} לא אישר/ה לפנות את הרכב',
   'ביום {{day}} {{timeRange}} — שום דבר לא השתנה.')
) as t(event, variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title, default_body = excluded.default_body;
