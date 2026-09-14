---
name: bugfixer
description: Triage, locate, fix and regression-test a small bug report in carshare-nevo (wrong behaviour vs a documented spec, a crash, an error toast, a small regression) — not a new feature. Use when asked to "fix a bug", "this is broken", "users report X", "the app shows the wrong Y", "getting an error when Z", or handed a short bug description to investigate. Routes real features to `/new-feature-checklist` instead of fixing them here.
---

# Bug fixer

A strict, minimal-diff playbook for one small bug. Built to run on cheap models: follow the steps in order, run the exact commands, do not improvise extra scope. Never commit, never deploy, never touch the hosted project, never run `npm run db:reset`, `npm run db:fake` or `npm run test:e2e` unless the user explicitly asks for it in this session (e2e global setup resets the local database).

**Budget:** read only the files a grep/step below points you to. Do not re-read whole docs — grep the section number and read just that section. Stop after step 6 (Summarise); do not start unrelated cleanup.

## Step 1 — Triage: bug or feature?

A **bug** = the docs (`docs/REQUIREMENTS.md`, `UX_FLOWS.md`, `SOLVER.md`, `DATA_MODEL.md`) already describe this behaviour and the code violates it, or the report is a crash / thrown error / console error / regression from a recent change, and the fix is small (one feature area, no new table/enum/screen). A **feature** = the docs don't describe this behaviour, or describe it differently on purpose.

| Report | Verdict | Why |
|---|---|---|
| "Return-day shows as a separate ride, not linked to the outbound leg" | Bug | REQ describes multi-day series as one linked series; code splits it — a spec violation with a small fix in the series-linking code |
| "Board crashes when a request has no destination" | Bug | Crash/regression, not a documented behaviour choice |
| "Sadran can't tell which cars are shared vs private on the board" | Feature | Nothing in REQ says private cars are hidden or flagged; this is new UI behaviour to design |
| "Hide private cars from the board entirely" | Feature | Changes documented behaviour (REQ says the board shows the department's cars) |
| "Proposal accept toast says the wrong day" | Bug | Copy/logic defect against a documented flow |
| "Add a WhatsApp reminder 1 hour before the window closes" | Feature | New notification event, not in the canonical 24 (CLAUDE.md consistency decision 5) |

Checklist:
- [ ] Grep the relevant doc section (see step 2 below for exact greps) and quote the section that governs this behaviour.
- [ ] If it's a feature → **stop**. Say so, name the doc section that shows it's undocumented/different, and point to `/new-feature-checklist`. Also check `docs/TODO.md` for whether the owner already triaged this idea; if not, suggest adding it there for owner review — do not add it yourself unless asked.
- [ ] If unsure after checking the doc → state exactly which section you checked and what it says, then ask **one** clarifying question. Do not guess and proceed.
- [ ] If it's a bug → continue to Step 2.

## Step 2 — Reproduce and locate

Pick the lane that matches the report. Don't run more than one unless the first doesn't locate it.

- **Hebrew UI text is wrong / a screen shows the wrong copy or state**
  - [ ] `grep -rn "<exact Hebrew fragment>" src/i18n/he*.ts` to find the key.
  - [ ] `grep -rn "<key found above>" src --include=*.ts --include=*.tsx` to find every usage (component/hook/page).
  - [ ] Hard rule: Hebrew only lives in `src/i18n/he*.ts`, `src/solver/reasons.ts`, and seeded DB data (`notification_templates`, `ride_types.name_he`, `destinations.name`, `weekday_labels`) — if the string isn't in `he*.ts`, check those two other places instead.

- **An error toast / thrown SQLSTATE**
  - [ ] Read the error code/message shown to the user.
  - [ ] `grep -n "<error code or message fragment>" src/lib/rpc.ts` — every mapped `ErrorCode` and its `he.errors.*` message is there (`toAppError`).
  - [ ] `grep -rn "<error code>" supabase/migrations/*.sql` to find the `raise` site and the RPC it's in.

- **Solver ranking/merge/suggestion looks wrong**
  - [ ] `npx vitest run src/solver` — check which existing test fails, or write a one-off fixture in `src/solver/__fixtures__` style to reproduce first.
  - [ ] Read only the specific rule/module file named in the failing test (`src/solver/rules/<type>.ts`, or the module from `docs/SOLVER.md` §3 module list), not the whole solver.

- **Permission / visibility looks wrong (RLS)**
  - [ ] Find the table/policy: `grep -n "create policy" supabase/migrations/*.sql | grep "<table>"`.
  - [ ] Run the specific SQL suite directly against the owner's already-running local stack (do **not** `db:reset`):
    ```sh
    docker exec -i supabase_db_$(grep -oP '(?<=project_id = ")[^"]+' supabase/config.toml) \
      psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/<suite>.sql
    ```
    (override the container name with `SUPABASE_DB_CONTAINER` if the owner's shell already exports it — see `scripts/test-db.mjs`.) SQL suites are transactional (rollback at the end), safe to run repeatedly.
  - [ ] Pick the suite by name from the folder map in `CLAUDE.md` (e.g. `rls_smoke.sql`, `hardening_semantics.sql`, `weekly_sadran_permissions.sql`).

- **UI flow / component logic**
  - [ ] Locate the feature folder (`src/features/<f>/`); read `api.ts` (the only place that calls `.rpc()`/`.from()`) before the component.

- **Docs vs code drift found along the way**
  - [ ] Note it for Step 3; don't chase it beyond this bug's scope. If it's bigger than this bug, mention `/review-consistency` in the summary instead of expanding the fix.

If present, `docs/TEST_MAP.md` maps changed paths → owning test suites — check it first if it exists; it will shortcut this whole step.

## Step 3 — Fix minimally

- [ ] Smallest change that makes the doc-defined (or crash-free) behaviour hold. No drive-by refactors, no unrelated file touches.
- [ ] Hard rules still apply: Hebrew only in the three places (Step 2's grep already found the right one); solver stays pure (no React/Supabase/`Date.now()`/`Math.random()`/i18n imports in `src/solver/**`); timestamps only via `src/lib/time.ts` (`dateKey`/`weekdayLabel`, never `getHours()`/`getDay()`/`toLocale*` outside `time.ts`/`dayLabels.ts`); any RLS/grant change stays explicit and per-command.
- [ ] If behaviour or copy changed, update the governing doc **in the same change** — usually one dated line in the relevant REQ §13 item or the matching UX_FLOWS section. One sentence, not a rewrite.
- [ ] Only write a migration if the bug truly requires a schema/RLS/RPC change (e.g. a missing grant, a wrong constraint). If so, stop here and follow `/add-migration` for that piece, then say so explicitly in the final summary — don't duplicate its checklist in this one.
- [ ] Never hand-edit generated files: `src/integrations/supabase/types.ts`, `src/components/ui/*`, `supabase/functions/_shared/solver.js`.

## Step 4 — Regression test

Pick exactly one, matching the bug's layer:

| Bug layer | Test to add | Pattern to follow |
|---|---|---|
| Pure logic (mapper, schema, small decision) | Vitest next to the file | Extract the decision into a pure function first if it's buried in a component/hook — see `src/features/requests/series.ts` + `series.test.ts` for the shape (pure function, co-located `*.test.ts`) |
| Solver rule/module | Vitest in `src/solver/rules/__tests__/` or `src/solver/__tests__/` | An existing sibling test file for the same rule/module |
| RPC / RLS / trigger | One assertion appended to the relevant file in `supabase/tests/*.sql` | Find the suite by table/RPC name (same suite Step 2 ran); add a case for the exact wrong behaviour, run it again with the same `docker exec … psql` command to confirm it now passes |
| User-visible flow | One Playwright step in the matching existing spec under `e2e/*.spec.ts` | Only if the bug is a flow (not a unit-testable function) — extend an existing spec, don't add a new file, unless truly nothing fits |

- [ ] Confirm the new test fails against the old code path logically (or actually revert-test it if cheap) and passes with the fix.
- [ ] If a regression test genuinely isn't practical here, say so explicitly in the summary and why (don't silently skip it).

## Step 5 — Verify

Run in this order, stop and fix on first failure:
- [ ] `npm run check` (lint + typecheck + unit tests) — always.
- [ ] `npm run functions:bundle` — only if anything under `src/solver/**` changed (CI diff-checks the bundle).
- [ ] If a migration was applied locally (`npx supabase migration up`), `npm run db:types` and commit the regenerated types.
- [ ] `npm run impact -- HEAD` — **if the script exists** (`grep -n '"impact"' package.json`) — run it and fold its output into the Impact line of the summary. If it doesn't exist yet, skip silently (another change may be introducing it).
- [ ] Do not run `npm run db:reset`, `npm run db:fake`, or `npm run test:e2e` unless the user explicitly asked for it in this session.

## Step 6 — Summarise

Use exactly this template, then stop:

```
Symptom: <what the user/report described>
Root cause: <file:line> — <one sentence>
Fix: <file(s) touched, one sentence per file>
Regression test: added <file> | proposed <file/pattern> (not added because <reason>)
Impact: <areas from docs/TEST_MAP.md or npm run impact output, if present; otherwise the feature folders/suites touched> — risk: low/medium/high
Deploy steps (owner runs these — this skill does not deploy, commit, or touch production):
  1. Commit this fix on main (this skill does not commit).
  2. `npm run release` (add `--dry-run` first to preview) — runs check, backup, pending migrations,
     changed edge functions, and pushes the release tag. Refuses to touch anything remote without
     `--yes-remote` (scripts/release.mjs).
  3. The tag only triggers CI — nothing deploys until the owner approves the `promote` job's
     `production` environment in GitHub. THAT CLICK is the one and only "deploy frontend" action.
  4. Post-release: run the smoke checklist in `docs/RUNBOOK_ROLLBACK.md`.
```

- [ ] Every deploy step is **listed**, never executed, by this skill — even if asked, hand the commands to the user instead of running them, and say why (releases are gated and owner-approved by design, `docs/FREE_DEPLOYMENT.md` §8, `docs/RUNBOOK_ROLLBACK.md`).
- [ ] Do not commit. Leave the working tree as-is for the user to review and commit.
