-- Owner 2026-11-07 (TODO TT1, SA1): copy only.
--   * the one-way trip type reads "כיוון אחד (הרכב נשאר ביעד)" everywhere (text_fragments `trip_type.one_way`, `{{tripType}}`);
--   * the board's "שלח את כל ההצעות" is now "שלח הצעות / עדכונים" (unsent-changes reminder copy).
-- Templates an admin has edited (body differs from the old default) keep the admin's text.

update public.text_fragments set body = 'כיוון אחד (הרכב נשאר ביעד)'
where key = 'trip_type.one_way' and body = 'הלוך בלבד';

update public.notification_templates
set body = case when body = default_body
                then 'בלוח של השבוע {{weekLabel}} יש הצעות או עדכונים שמחכים ל"שלח הצעות / עדכונים" (בתפריט ⋮).'
                else body end,
    default_body = 'בלוח של השבוע {{weekLabel}} יש הצעות או עדכונים שמחכים ל"שלח הצעות / עדכונים" (בתפריט ⋮).'
where event = 'publish_reminder' and variant = 'unsent_changes';
