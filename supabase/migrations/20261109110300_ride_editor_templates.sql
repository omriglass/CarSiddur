-- REQ §13.202 copy: the new editor's one inbox message, and the owner's notice when an editor withdraws or cancels.
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select t.event::public.notification_event, ch::public.notification_channel, t.variant, t.title, t.body, t.title, t.body
from (values
  ('ride_editor_added', null,
   '{{name}} נתן/ה לך לערוך את הנסיעות שלו/ה',
   'מעכשיו אפשר לערוך ולבטל את הבקשות והנסיעות של {{name}}, ו{{name}} יקבל/תקבל הודעה על כל שינוי. כדי לראות אותן ב״הנסיעות שלי״, יש לסמן ״הצגת נסיעות של מי שנתנו לי לערוך״ בתפריט התצוגה.'),
  ('ride_edited', 'editor_withdrew', '{{byName}} הסיר/ה את הבקשה שלך', '{{route}} · {{day}}'),
  ('ride_edited', 'editor_cancelled', '{{byName}} ביטל/ה את הנסיעה שלך', '{{route}} · {{day}}')
) as t(event, variant, title, body)
cross join (values ('inbox'), ('push')) as c(ch)
on conflict (event, channel, coalesce(variant, '')) do nothing;
