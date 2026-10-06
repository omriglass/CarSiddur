-- REQ §13.102 / docs/COPY_DRAFT_2026-10.md (QA run 2: R2B4, R2B10, R2M2, R2M5, R2Q3, R2B1, R2B21).
-- Fragments and templates only (Hebrew lives in seeded data, never in function bodies). Upserts, so a fresh
-- `db reset` gets them before seed.sql's `on conflict do nothing` rows.
insert into public.text_fragments (key, body) values
  ('leg.out',           'הלוך בלבד'),
  ('leg.return',        'חזור בלבד'),
  ('leg.both',          'הלוך וחזור'),
  ('join.out_change',   'הלוך בלבד — {{change}}'),
  ('join.return_change','חזור בלבד — {{change}}'),
  ('join.both_change',  'הלוך וחזור — {{change}}'),
  ('join.split_out',    'הלוך עם {{driverName}} ({{car}}) — {{times}}'),
  ('join.split_return', 'חזור עם {{driverName}} ({{car}}) — {{times}}'),
  ('join.split_out_nodriver',    'הלוך ברכב {{car}} (עוד מחפש נהג/ת) — {{times}}'),
  ('join.split_return_nodriver', 'חזור ברכב {{car}} (עוד מחפש נהג/ת) — {{times}}'),
  ('join.split_sep',    '; '),
  ('window.both',       '{{depart}}–{{return}}'),
  ('window.out',        '{{depart}}'),
  ('window.return',     'חזרה ב{{return}}'),
  ('external.hint.cab',              'האם אפשר להסתדר עם מונית?'),
  ('external.hint.rental',           'האם אפשר להסתדר עם רכב שכור?'),
  ('external.hint.public_transport', 'האם אפשר להשתמש בתחבורה ציבורית?'),
  ('external.hint.private',          'האם אפשר להסתדר עם רכב פרטי או פתרון אחר?'),
  ('publish.line',      '{{route}} {{day}}: {{changeLine}}'),
  ('publish.more',      'ועוד {{count}}'),
  ('publish.new_ride',  'שובצת — {{car}} · {{depart}}–{{return}}'),
  ('publish.removed',   'השיבוץ הוסר')
on conflict (key) do update set body = excluded.body, updated_at = now();

-- Push / inbox rows.
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select t.event::public.notification_event, ch.channel::public.notification_channel, t.variant, t.title, t.body, t.title, t.body
from (values
  ('proposal_received', 'shift_placed',   'הצעה: להזיז את הנסיעה {{route}}', '{{day}} · {{timeChange}}{{carLine}}'),
  ('proposal_received', 'merge_passenger_split', 'הצעה: להצטרף לנסיעה {{route}}', '{{day}} · {{joinLine}}'),
  ('proposal_received', 'merge_host',     'הצעה: לצרף את {{joinerName}} לנסיעה שלך', '{{route}} · {{day}} · {{legWord}} · {{timeChange}}{{detourLine}}'),
  ('proposal_received', 'merge_other',    'הצעה: לצרף את {{joinerName}} לנסיעה שלך', '{{route}} · {{day}} · {{legWord}} · {{timeChange}}'),
  ('proposal_received', 'merge_host_ask', '{{joinerName}} מבקש/ת להצטרף אליך', '{{route}} · {{day}} · {{legWord}} · {{timeChange}}{{detourLine}}'),
  ('proposal_received', 'merge_other_ask','{{joinerName}} מבקש/ת להצטרף לנסיעה שלך', '{{route}} · {{day}} · {{legWord}} · {{timeChange}}'),
  ('proposal_received', 'external_city',  'אין רכב ב{{city}} ביום {{day}}', '{{destinationRoute}} · {{window}} · לאשר להסתדר, או להישאר בהמתנה'),
  ('proposal_received', 'external_city_home', 'אין רכב ב{{city}} ביום {{day}}', '{{window}} · לאשר להסתדר, או להישאר בהמתנה'),
  ('proposal_received', 'external_none',  'אין רכב פנוי {{route}}', '{{day}} {{window}} · להסתדר בעצמך או להישאר בהמתנה'),
  ('proposal_received', 'deny',           'לא נמצא רכב {{route}}', '{{day}} {{window}} · {{reasonLine}}'),
  ('proposal_received', 'origin_placed',  'הצעה: להזיז את היציאה ל{{newOrigin}}', '{{route}} · {{day}} · {{car}}'),
  ('outcome_changed',   'merged_split',   'שובצת כנוסע/ת {{route}}', '{{day}} · {{joinLine}}'),
  ('outcome_changed',   'external_accepted', 'הבקשה נסגרה — מסתדר/ת בעצמך', 'סימנת שתסתדר/י בעצמך {{route}} ביום {{day}} — הבקשה נסגרה'),
  ('outcome_changed',   null,             'שינוי בסידור שלך — {{days}}', '{{diffLine}}'),
  ('proposal_answered', 'withdrawn_stale',  'ההצעה ל{{firstName}} בוטלה', '{{destination}}, יום {{day}} — אחרי שינויים בסידור ההצעה כבר לא אפשרית'),
  ('proposal_answered', 'withdrawn_placed', 'ההצעה ל{{firstName}} בוטלה', '{{destination}}, יום {{day}} — הבקשה כבר שובצה או הצטרפה לדיון'),
  ('waitlist_resolved', null,             'רשימת ההמתנה ליום {{day}} הוסדרה', '{{names}} — ברכב ב{{depart}}–{{return}}.'),
  ('waitlist_resolved', 'not_chosen',     'הדיון על הרכב ליום {{day}} הוכרע', 'הרכב הפעם: {{names}}. הבקשה שלך נשארת ברשימת ההמתנה.')
) as t(event, variant, title, body)
cross join (values ('inbox'), ('push')) as ch(channel)
on conflict (event, channel, (coalesce(variant, ''))) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title,
      default_body = excluded.default_body, updated_at = now();

-- WhatsApp rows (body only; every one carries {{link}}).
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'proposal_received', 'whatsapp', t.variant, null, t.body, null, t.body
from (values
  ('shift_placed', $b$היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗
{{route}} ביום {{day}}: אני מציע/ה להזיז — {{timeChange}}{{carLine}}.
מתאים/ה? אפשר לאשר או לדחות כאן:
{{link}}$b$),
  ('merge_passenger', $b$היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗
במקום רכב נפרד: להצטרף כנוסע/ת אל {{driverName}} ({{car}}) {{route}} ביום {{day}}.
{{joinLine}}.
מתאים/ה? תשובה כאן:
{{link}}$b$),
  ('merge_passenger_no_driver', $b$היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗
במקום רכב נפרד: להצטרף לנסיעה {{route}} ביום {{day}} ({{car}}), שעוד מחפשת נהג/ת.
{{joinLine}}.
מתאים/ה? תשובה כאן:
{{link}}$b$),
  ('merge_passenger_split', $b$היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗
במקום רכב נפרד: להצטרף כנוסע/ת {{route}} ביום {{day}} בשני רכבים.
{{joinLine}}.
מתאים/ה? תשובה כאן:
{{link}}$b$),
  ('merge_host', $b$היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗
אני מציע/ה לצרף את {{joinerName}} ({{legWord}}) לנסיעה שלך {{route}} ביום {{day}}.
{{timeChange}}{{detourLine}}.
מתאים/ה? תשובה כאן:
{{link}}$b$),
  ('merge_other', $b$היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗
אני מציע/ה לצרף את {{joinerName}} ({{legWord}}) לנסיעה שלך {{route}} ביום {{day}}.
{{timeChange}}.
מתאים/ה? תשובה כאן:
{{link}}$b$),
  ('merge_host_ask', $b$היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗
{{joinerName}} מבקש/ת להצטרף ({{legWord}}) לנסיעה שלך {{route}} ביום {{day}}.
{{timeChange}}{{detourLine}}.
מתאים/ה? תשובה כאן:
{{link}}$b$),
  ('merge_other_ask', $b$היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗
{{joinerName}} מבקש/ת להצטרף ({{legWord}}) לנסיעה שלך {{route}} ביום {{day}}.
{{timeChange}}.
מתאים/ה? תשובה כאן:
{{link}}$b$),
  ('external_city', $b$היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗
אין כרגע רכב ב{{city}} {{destinationRoute}} ביום {{day}} {{window}}.
{{reasonNote}}אפשר להגיע לקיבוץ בעצמך ולצאת משם, או להישאר ברשימת ההמתנה. תשובה כאן:
{{link}}$b$),
  ('external_city_home', $b$היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗
אין כרגע רכב ב{{city}} ביום {{day}} {{window}}.
{{reasonNote}}אפשר להסתדר בעצמך, או להישאר ברשימת ההמתנה. תשובה כאן:
{{link}}$b$),
  ('external_none', $b$היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗
לצערי כל הרכבים תפוסים {{route}} ביום {{day}} {{window}}, גם עם הזזה.
{{reasonNote}}{{externalSuggestion}} אם יתפנה רכב נעדכן אותך אוטומטית. תשובה כאן:
{{link}}$b$),
  ('deny', $b$היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗
לא הצלחנו לשבץ רכב {{route}} ביום {{day}} {{window}}.
{{reasonLine}}
אם יתפנה רכב נעדכן אותך אוטומטית. פרטים:
{{link}}$b$),
  ('origin', $b$היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗
{{route}} ביום {{day}}: אין רכב ב{{originOrHome}}, אבל {{car}} פנוי ב{{newOrigin}}.
נקודת היציאה משתנה ל{{newOrigin}} (מ{{originOrHome}}), השעות נשארות {{window}}. מתאים/ה?
{{link}}$b$),
  ('origin_placed', $b$היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗
{{route}} ביום {{day}}: אני מציע/ה להזיז את נקודת היציאה ל{{newOrigin}} (מ{{originOrHome}}), ברכב {{car}}. השעות נשארות {{window}}.
מתאים/ה?
{{link}}$b$)
) as t(variant, body)
on conflict (event, channel, (coalesce(variant, ''))) do update
  set body = excluded.body, default_body = excluded.default_body, updated_at = now();
