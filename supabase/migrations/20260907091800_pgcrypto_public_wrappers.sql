-- Fix (found while smoke-testing the stage 2d Edge Functions against
-- create_proposal/send_proposal/answer_proposal): pgcrypto was installed into
-- the `extensions` schema (20260907090000_extensions_and_enums.sql, Supabase
-- CLI default), which is on the `postgres` role's search_path (its rolconfig
-- sets `search_path = "$user", public, extensions`) but is NOT on the
-- database's default search_path (`"$user", public`) used by the `authenticated`,
-- `anon` and `service_role` connection roles (PostgREST / Edge Functions). Every
-- `security definer set search_path = public, pg_temp` function that calls
-- `gen_random_bytes()`/`digest()` unqualified — `generate_token()`,
-- `create_proposal()`, `send_proposal()`, `answer_proposal()`,
-- `record_answer_on_behalf()` (20260907091500_rpc.sql) — therefore fails with
-- `function gen_random_bytes(integer) does not exist` whenever called as
-- anything other than the `postgres` superuser (i.e. always, in practice: the
-- app never connects as `postgres`). `seed.sql`'s own `crypt()`/`gen_salt()`
-- calls happened to work only because `supabase db reset` runs it as `postgres`.
--
-- Fix without touching any committed migration/RPC body: thin public-schema
-- wrappers so the existing unqualified calls resolve under the default
-- `public` search_path. No RPC signatures change; no data migration needed.
-- Recorded in docs/DATA_MODEL.md §6.1.

create or replace function public.gen_random_bytes(count integer) returns bytea
language sql volatile as $$ select extensions.gen_random_bytes(count); $$;

create or replace function public.digest(data text, type text) returns bytea
language sql immutable as $$ select extensions.digest(data, type); $$;

create or replace function public.digest(data bytea, type text) returns bytea
language sql immutable as $$ select extensions.digest(data, type); $$;

create or replace function public.crypt(password text, salt text) returns text
language sql volatile as $$ select extensions.crypt(password, salt); $$;

create or replace function public.gen_salt(type text) returns text
language sql volatile as $$ select extensions.gen_salt(type); $$;

revoke all on function public.gen_random_bytes(integer) from anon;
revoke all on function public.digest(text, text) from anon;
revoke all on function public.digest(bytea, text) from anon;
revoke all on function public.crypt(text, text) from anon;
revoke all on function public.gen_salt(text) from anon;
grant execute on function public.gen_random_bytes(integer) to authenticated, service_role;
grant execute on function public.digest(text, text) to authenticated, service_role;
grant execute on function public.digest(bytea, text) to authenticated, service_role;
grant execute on function public.crypt(text, text) to authenticated, service_role;
grant execute on function public.gen_salt(text) to authenticated, service_role;
