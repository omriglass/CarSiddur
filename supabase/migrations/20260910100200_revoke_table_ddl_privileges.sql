-- Hygiene from the same audit (docs/HARDENING_2026-09.md §1.1): Supabase's default
-- `grant all on tables` also handed anon/authenticated TRUNCATE (which bypasses RLS),
-- TRIGGER and REFERENCES on every table. PostgREST never issues these, but nothing should
-- rely on that. anon keeps no table grants at all (DATA_MODEL §4.1).

revoke truncate, trigger, references on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke truncate, trigger, references on tables from anon, authenticated;
