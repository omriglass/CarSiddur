-- notification_templates default snapshot (stage 1c follow-up #4, DATA_MODEL.md §6.1 item 15).
-- REQ §9; DATA_MODEL.md §3.11.
--
-- The admin UI's "שחזר ברירת מחדל" ("restore default") re-inserts the seed row today, which
-- means the seed Hebrew copy would otherwise have to be duplicated in TS (violating hard rule 3:
-- Hebrew lives only in he.ts / solver/reasons.ts / seeded data). Adding `default_title` /
-- `default_body` columns, populated once from the seed values in supabase/seed.sql, lets
-- "restore default" simply copy these columns back onto `title`/`body` for the row — no Hebrew
-- in TS at all.

alter table public.notification_templates
  add column default_title text,
  add column default_body text;

comment on column public.notification_templates.default_title is
  'Seed-time snapshot of title, for the admin "restore default" action; null for rows with no seeded default.';
comment on column public.notification_templates.default_body is
  'Seed-time snapshot of body, for the admin "restore default" action; null for rows with no seeded default.';
