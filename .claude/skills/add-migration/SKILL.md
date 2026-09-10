---
name: add-migration
description: Write a new Supabase/Postgres SQL migration safely (naming, enums, tables with RLS via the helper functions, per-command policies, indexes, triggers, RPCs, regenerate types, seed, local reset, DATA_MODEL.md). Use when asked to "add a table", "add a column", "add an enum value", "change the schema", "write a migration", "add an index", "add a policy", "add an RPC".
---

# Add a migration

Every schema change is a new file in `supabase/migrations/`. Never edit a committed migration. Conventions come from `docs/DATA_MODEL.md` §0 (house rules), §4 (RLS), §6 (migration plan) — read those sections first. Helper names below are from §4.2; if the repo differs, fix this file.

## Naming
- `supabase/migrations/YYYYMMDDHHMMSS_verb_object.sql` — the Supabase CLI form, created with `npm run db:new -- verb_object` (`supabase migration new`), e.g. `20261103141500_create_car_loans.sql`. `supabase db push` orders by the timestamp, so never rename a file and never hand-pick a timestamp older than the last committed one. The initial 18-step plan (`20260907090000_extensions_and_enums.sql` … `20260907091700_views.sql`) is in DATA_MODEL §6.
- Verbs: `create_`, `add_`, `alter_`, `drop_`, `seed_`, `fix_`. One concern per file. `alter type … add value` **alone** in its file (value unusable in the same transaction).
- Header comment: purpose + `-- REQ §x.y` reference.

## Steps

### 1. Write the SQL
- [ ] **Enums**: `create type public.<name> as enum (...)`, singular snake_case. Extend with `alter type … add value [before|after]`. Never rename/remove; mark deprecated in DATA_MODEL §2.
- [ ] **Tables**:
  ```sql
  create table public.<plural> (
    id uuid primary key default gen_random_uuid(),
    department_id uuid not null references public.departments(id) on delete cascade,
    week_start date,                       -- if week-scoped: NN + composite FK below
    ...,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  -- week-scoped: foreign key (department_id, week_start) references public.weeks (department_id, week_start)
  create trigger set_updated_at before update on public.<plural> for each row execute function public.set_updated_at();
  ```
  - `timestamptz` only; `date` only for Jerusalem calendar days (`week_start` must satisfy `extract(dow from week_start) = 0`).
  - Denormalize `department_id` onto every department-scoped row (RLS never joins).
  - State tables (`version int not null default 1`) get `bump_version()`; audited tables get `audit_row()` (see the attach list in `20260907091300_audit_log.sql`) — and add the table to `audit_row()`'s `subject_profile_id` resolution if it has a "member the row is about".
  - FKs declare `on delete`; CHECK constraints for ordering/ranges/15-min alignment (`is_quarter_hour()`).
  - Immutable history tables: `forbid_mutation()` trigger.
- [ ] **RLS** (mandatory, in the same file as the table):
  ```sql
  alter table public.<plural> enable row level security;
  alter table public.<plural> force row level security;

  create policy "<plural>_select" on public.<plural> for select to authenticated
    using (public.member_of(department_id) or public.is_admin());
  create policy "<plural>_insert" on public.<plural> for insert to authenticated
    with check (public.can_manage_week(department_id, week_start));
  create policy "<plural>_update" on public.<plural> for update to authenticated
    using (public.can_manage_week(department_id, week_start))
    with check (public.can_manage_week(department_id, week_start));
  -- delete: usually admin only, or none (rows are cancelled, not deleted)
  ```
  - Helpers (DATA_MODEL §4.2): `is_approved()`, `is_admin()`, `member_of(dept)`, `is_sadran(dept, week_start)`, `is_sadran_any(dept)`, `can_manage_week(dept, week_start)`, `is_week_public(dept, week_start)`, `phone_of(profile)`. Use `(select auth.uid())` for own-row checks.
  - Per command, never `for all`; no `using (true)` on writes; nothing for `anon`.
  - Draft data (unpublished rides, proposals, solver runs) readable only by `can_manage_week`; members see published rows via `is_week_public` (REQ §10).
  - Multi-row or state-changing operations → `security definer` RPC that re-checks with the same helpers and sets `app.audit_reason`; grant direct write policies only for single-row own-data edits. `requests` has **no** direct INSERT/UPDATE policy at all — everything goes through `submit_request(payload jsonb)` and the state RPCs (DATA_MODEL §3.6).
  - Notifications: never insert into `notifications`/`push_outbox`; call `enqueue_notification(recipient, event, dept, week_start, vars, data, dedupe_key)`.
  - Scheduled work: do not add `cron.schedule` entries — there is exactly one (`app.tick()`); extend the relevant tick sub-function instead (`/change-weekly-cycle-defaults`).
- [ ] **Indexes**: FK columns that are filtered; `(department_id, week_start[, status])` on week-scoped tables; partial indexes for hot statuses; GiST for `tstzrange` overlap.
- [ ] **Functions**: `security definer` only when needed, then `set search_path = public, pg_temp`; `stable`/`immutable` where true. Grants are default-closed (`20260910099000`) — `revoke execute … from public, anon` is no longer needed, but a browser-called RPC still needs an explicit `grant execute on function … to authenticated`; a helper referenced only by an RLS policy/view/constraint/index expression also needs `authenticated` (it runs as the querying role). An internal/cron function gets no grant at all — if it is one of the highest-risk internal functions (guardable via PostgREST), add it to `rls_smoke.sql` TEST 14's list and consider calling `assert_not_direct_rpc(p_function)` first (DATA_MODEL §4.2 "Function grants").
- [ ] **Views**: `with (security_invoker = true)`; joins only, RLS of base tables applies.

### 2. Apply and generate
- [ ] `npm run db:reset` — must pass from scratch (migrations + `supabase/seed.sql`).
- [ ] `npm run db:types` → commit `src/integrations/supabase/types.ts`; `git diff` shows only the expected change.
- [ ] Enums → `src/lib/enums.ts` mirror (const + zod + `assertSameEnum`) and `he.enums.*` labels; `npm run typecheck`.

### 3. Seed (`supabase/seed.sql`)
- [ ] Representative rows (at least one per new enum value where realistic), fixed UUIDs `00000000-0000-0000-0000-0000000000NN` for e2e references, idempotent (`on conflict do nothing/update`). Production gets only catalogs/settings/invites.

### 4. Tests
- [ ] `supabase/tests/rls_spec.sql` already asserts every table has RLS and no `true` qual on writes — run it (`supabase test db`). Add a table-specific case: member of dept A cannot read dept B rows; Sadran of (A, week) can write; plain member cannot write; anon gets nothing.
- [ ] Trigger/RPC logic: SQL test for the happy path and one refusal.

### 5. Docs
- [ ] `docs/DATA_MODEL.md`: table section (columns/types/defaults/meaning), §2 enum values, §4.3 policy-matrix row, §5 invariants if you added a constraint/trigger, §6 migration table row, §8 retention row.
- [ ] `docs/ARCHITECTURE.md` §7 (where a rule is enforced) / §10 (cron) if relevant.
- [ ] `docs/REQUIREMENTS.md` only if behavior changed.

## Final verification
- [ ] `npm run db:reset` passes; `supabase test db` (rls_spec) passes; `npm run typecheck && npm run test` pass.
- [ ] No table without RLS: `select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where nspname='public' and relkind='r' and not (relrowsecurity and relforcerowsecurity);` is empty.
- [ ] No `timestamp without time zone`: `select table_name, column_name from information_schema.columns where table_schema='public' and data_type='timestamp without time zone';` is empty.
- [ ] `select polname, polcmd from pg_policy where polcmd = '*'` is empty (no `for all`).
- [ ] DATA_MODEL.md mentions every new table/column/enum value/function.
