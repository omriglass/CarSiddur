-- REQ §13.104 e / QA run 4 (R4F3, R4B6, R4U3, R4U7): proposal titles state old -> new (and the added minutes),
-- the joiner's own return stops and "the ride continues to X" are part of the join line, and a merge into a ride
-- still needing a driver reads "הנסיעה עוד מחפשת נהג/ת". Hebrew lives in seeded data only.
insert into public.text_fragments (key, body) values
  ('title.change',      ' — {{change}}'),
  ('title.added_min',   '+{{min}} דק׳'),
  ('join.return_via',   'חזור דרך {{stops}}'),
  ('join.continues',    'הנסיעה ממשיכה ל{{rideDestination}}')
on conflict (key) do update set body = excluded.body;

-- Titles (inbox + push share them). {{titleChange}} is '' when nothing changes.
update public.notification_templates t
set title = v.title, default_title = v.title, updated_at = now()
from (values
  ('proposal_received', 'shift',                 'הצעה: להזיז את הנסיעה {{route}}{{titleChange}}'),
  ('proposal_received', 'shift_placed',          'הצעה: להזיז את הנסיעה {{route}}{{titleChange}}'),
  ('proposal_received', 'merge_host',            'הצעה: לצרף את {{joinerName}} לנסיעה שלך{{titleChange}}'),
  ('proposal_received', 'merge_host_ask',        '{{joinerName}} מבקש/ת להצטרף אליך{{titleChange}}'),
  ('proposal_received', 'merge_other',           'הצעה: לצרף את {{joinerName}} לנסיעה שלך{{titleChange}}'),
  ('proposal_received', 'merge_other_ask',       '{{joinerName}} מבקש/ת להצטרף לנסיעה שלך{{titleChange}}'),
  ('proposal_received', 'merge_passenger',       'הצעה: להצטרף לנסיעה של {{driverName}}{{titleChange}}'),
  ('proposal_received', 'merge_passenger_no_driver', 'הצעה: להצטרף לנסיעה {{route}}{{titleChange}}'),
  ('proposal_received', 'merge_passenger_split', 'הצעה: להצטרף לנסיעה {{route}}{{titleChange}}'),
  ('proposal_received', 'origin',                'הצעה: לצאת מ{{newOrigin}} במקום מ{{originOrHome}}'),
  ('proposal_received', 'origin_placed',         'הצעה: להזיז את היציאה ל{{newOrigin}} במקום מ{{originOrHome}}'),
  ('outcome_changed',   'merged',                'שובצת כנוסע/ת {{route}}{{titleChange}}'),
  ('outcome_changed',   'merged_no_driver',      'שובצת כנוסע/ת {{route}}{{titleChange}}'),
  ('outcome_changed',   'merged_split',          'שובצת כנוסע/ת {{route}}{{titleChange}}')
) as v(event, variant, title)
where t.event = v.event::public.notification_event and t.variant = v.variant and t.channel in ('inbox', 'push');

update public.notification_templates
set body = replace(body, ', שעוד מחפשת נהג/ת.', '. הנסיעה עוד מחפשת נהג/ת.'),
    default_body = replace(default_body, ', שעוד מחפשת נהג/ת.', '. הנסיעה עוד מחפשת נהג/ת.'),
    updated_at = now()
where event = 'proposal_received' and channel = 'whatsapp' and variant = 'merge_passenger_no_driver';
