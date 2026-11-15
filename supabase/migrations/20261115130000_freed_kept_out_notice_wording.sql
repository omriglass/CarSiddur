-- REQ item 237 (owner 2026-11-15): the keep-out answer now reads "… זה בדיון עם אנשים מחוץ לאפליקציה"; the Sadranim's
-- inbox message follows the same wording. An admin-edited body is left alone; the default always moves.
update public.notification_templates
   set body = case when body = default_body
                   then '{{byName}} פינה/תה את {{car}} ביום {{day}} {{timeRange}}, והנושא בדיון עם אנשים מחוץ לאפליקציה. הרכב לא הוצע לממתינים.'
                   else body end,
       default_body = '{{byName}} פינה/תה את {{car}} ביום {{day}} {{timeRange}}, והנושא בדיון עם אנשים מחוץ לאפליקציה. הרכב לא הוצע לממתינים.'
 where event = 'claim_contested' and channel = 'inbox' and variant = 'freed_kept_out';
