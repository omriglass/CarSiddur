-- REQ §13.93 (ORIGINS_PLAN §3/§4 "O4b", 2026-10-04): WhatsApp copy for the `origin` proposal
-- type -- the solver's "car free at a different place" (`changeOrigin`) suggestion, sent from
-- the board's unmet list exactly like every other suggestion kind (SOLVER §3.15). Production
-- defaults must ship in migrations: seed.sql is local/demo only. Mirrors
-- 20260908121000_status_notifications.sql's whatsapp proposal_received rows.
--
-- `{{origin}}`/`{{newOrigin}}` (the request's current origin vs. the free car's origin) and
-- `{{car}}` (that car's name) are baked into `reason_he` by the composer at creation time
-- (`ProposalComposerScreen.tsx`'s `baseVars()`), same as every other proposal_received
-- variable here -- `notification_context()`'s `proposalShort` only strips `{{link}}` from the
-- already-rendered text, so no SQL var-builder change is needed.
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'proposal_received'::public.notification_event, 'whatsapp'::public.notification_channel, 'origin', null,
  'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
  'ביקשת רכב ל{{destination}} ביום {{day}}, יציאה מ{{origin}}.' || chr(10) ||
  'אין רכב פנוי מ{{origin}} בשעות האלה, אבל יש רכב פנוי מ{{newOrigin}} ({{car}}).' || chr(10) ||
  'מתאים לך לצאת מ{{newOrigin}}? אפשר לאשר או לדחות כאן:' || chr(10) || '{{link}}',
  null,
  'היי {{firstName}}, זה/זו {{sadranName}} מסידור הרכב 🚗' || chr(10) ||
  'ביקשת רכב ל{{destination}} ביום {{day}}, יציאה מ{{origin}}.' || chr(10) ||
  'אין רכב פנוי מ{{origin}} בשעות האלה, אבל יש רכב פנוי מ{{newOrigin}} ({{car}}).' || chr(10) ||
  'מתאים לך לצאת מ{{newOrigin}}? אפשר לאשר או לדחות כאן:' || chr(10) || '{{link}}'
on conflict (event, channel, coalesce(variant, '')) do nothing;
