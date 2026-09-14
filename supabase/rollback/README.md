# `supabase/rollback/` — tested down scripts for non-additive migrations

CLAUDE.md's forward-fix rule (owner decision 2026-09-14 #4): migrations are
additive, expand/contract — never drop or rename a column or table in the
same release the running frontend still uses. When a migration truly cannot
avoid a destructive statement (drop table/column, `alter table … drop …`,
`rename column`, `rename to`, `alter type … rename`, `drop function` without a
same-name replacement, or a `drop policy`/`drop trigger` with no
re-creation), it ships together with a **tested** down script here.

`scripts/check-migrations.mjs` (run in CI's `check` job, and by
`npm run release` before pushing migrations) scans every new migration for
those patterns and fails the build if a matching down script is missing —
see that file's header comment for exactly which statements it flags and the
two narrow exceptions (function-signature replacement; drop-then-recreate of
a policy/trigger).

## Naming convention

```
supabase/rollback/<same 14-digit timestamp as the migration>_down.sql
```

Example: `supabase/migrations/20260914100100_drop_old_column.sql` pairs with
`supabase/rollback/20260914100100_down.sql`.

## Writing one

1. Write the down script as the exact inverse of the migration's destructive
   statement(s) — restore the dropped column/table/function/policy, or
   reverse the rename. It does not need to restore *data* that a `drop
   column`/`drop table` destroyed (that's what the pre-release backup is
   for — docs/RUNBOOK_ROLLBACK.md's database section); it needs to restore
   *schema* so the previous frontend/RPCs work again.
2. Test it locally before committing, against the local stack:
   ```sh
   npx supabase migration up          # apply every migration, including the new one
   psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')" -f supabase/rollback/<ts>_down.sql
   ```
   or simpler, against the local Postgres container directly:
   ```sh
   docker exec -i supabase_db_<project_id> psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
     < supabase/rollback/<ts>_down.sql
   ```
   Confirm the schema is back to its pre-migration shape (`\d table_name`,
   `\df function_name`) and that `npm run db:test` still passes afterward.
3. Commit the down script in the **same change** as the migration it undoes.

## Using one (rollback)

See `docs/RUNBOOK_ROLLBACK.md` → "Database" for when a forward-fix (a new
migration) is preferred over running a down script, and the full command
(`psql "$DB_URL" -f supabase/rollback/<ts>_down.sql` followed by
`supabase migration repair --status reverted <ts>`).

## Never

- Never edit a committed migration file to remove the destructive statement
  after the fact — ship a new migration instead (migrations are immutable,
  CLAUDE.md naming conventions).
- Never treat a down script as a substitute for the pre-release backup: it
  restores schema, not the data a destructive statement discarded.
