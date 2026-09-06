# CLAUDE.md — carshare-nevo

Guidance for Claude Code working in this repository.

## Overview

- Hebrew, mobile-first PWA for Kibbutz Nevo's shared car fleet: members file weekly ride requests, a Sadran (coordinator) solves, negotiates leftovers via proposals, and publishes the weekly "siddur" (סידור רכב).
- The app **proposes**; a human always decides. The solver ranks requests with a data-driven, admin-editable priority policy.
- Stack: Vite + React 18 + TypeScript strict + shadcn/ui + Tailwind + TanStack Query + react-router; Supabase (Postgres, Google Auth, RLS, Edge Functions, pg_cron); Vitest + Playwright; Vercel Hobby. Free tiers only.
- `docs/REQUIREMENTS.md` is the source of truth for *what*; `ARCHITECTURE.md`, `DATA_MODEL.md`, `SOLVER.md`, `UX_FLOWS.md` derive from it and must never contradict it.
- **Status: design phase, no application code yet.** Paths and commands below come from the docs. Once code lands, verify and correct this file in the same PR (see "To be verified" at the bottom).

## Hard rules

1. **Never modify `../commucar-share`.** Read-only reference. Do not import from it, copy files from it, or run commands inside it.
2. **Docs are the source of truth and move with the code.** Any change to behavior, schema, states, enums, rule types, notifications or screens updates the relevant `docs/*.md` **in the same change**. If REQUIREMENTS.md does not cover it, add it there first (the owner reviews requirements, not code).
3. **Hebrew lives in exactly three places.** (a) `src/i18n/he.ts` — every UI string, via `useT()`; (b) `src/solver/reasons.ts` — every solver string keyed by `reasonCode` (reason templates, rule descriptions `RULE_<TYPE>_DESC`, `PolicyParamsError` messages), so the edge bundle is self-contained and rule files contain no Hebrew; (c) seeded data — `notification_templates` (push/inbox/WhatsApp copy), `ride_types.name_he`, destination names. Never inline Hebrew in components, hooks, rule files, SQL logic, or edge functions. Identifiers, docs and comments are English.
4. **RLS on every table**, `enable` + `force`, policies per command (never `for all`), written with the helper functions in `DATA_MODEL.md` §4.2 (`is_approved()`, `is_admin()`, `member_of(dept)`, `is_sadran(dept, week_start)`, `is_sadran_any(dept)`, `can_manage_week(dept, week_start)`, `is_week_public(dept, week_start)`). Multi-row state changes go through `SECURITY DEFINER` RPCs. `anon` has no grants. Service-role keys never reach the browser.
5. **The solver stays pure.** `src/solver/**` imports nothing from React, Supabase, the DOM, `Date.now()`, `Math.random()`, or `src/i18n`. `solve(input)` returns a value; persistence is the caller's job (`apply_solver_result` RPC). Deterministic: every sort ends in an `id` tie-break.
6. **All timestamps are Asia/Jerusalem-aware.** Postgres: `timestamptz` only; `week_start date` (the Sunday) keys a week; wall-clock settings are stored as `(dow, time)` and converted inside SQL with `at time zone 'Asia/Jerusalem'`. TS: `src/lib/time.ts` (`TZ = 'Asia/Jerusalem'`, date-fns-tz); never `getHours()`/`getDay()`/`toLocale*` without it. The solver never does wall-clock arithmetic — it gets epoch ms and per-day slot bounds.
7. **Before declaring anything done:** `npm run lint && npm run typecheck && npm run test` pass. Schema changes also need `npm run db:reset && npm run db:types` with the regenerated types committed. User-facing flows run the relevant Playwright spec.
8. **Never hand-edit generated files:** `src/integrations/supabase/types.ts`, `src/components/ui/*` (shadcn CLI), `supabase/functions/_shared/solver.js` (built by `scripts/bundle-solver`).
9. **Enums are defined once, in SQL**, mirrored into `src/lib/enums.ts` (see Conventions). Priority **rule types are the exception**: they are a TS registry (`src/solver/rules/index.ts`) mirrored into the SQL `validate_policy_rules()` known set.

## Commands (planned — verify against `package.json`)

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server on `:8080` against local Supabase |
| `npm run build` | Production build (also bundles the solver for edge functions) |
| `npm run lint` | ESLint over `src/`, `e2e/`, `supabase/functions/` |
| `npm run typecheck` | `tsc --noEmit -p tsconfig.app.json` |
| `npm run test` / `test:watch` | `vitest run` / `vitest` |
| `npm run e2e` | `playwright test` (needs `supabase start` + dev server) |
| `npm run db:start` / `db:stop` | `supabase start` / `supabase stop` (Docker) |
| `npm run db:reset` | `supabase db reset` — replays `supabase/migrations` + `supabase/seed.sql` |
| `npm run db:new -- <name>` | `supabase migration new <name>` → `supabase/migrations/YYYYMMDDHHMMSS_<name>.sql` (never rename) |
| `npm run db:types` | `supabase gen types typescript --local > src/integrations/supabase/types.ts` |
| `npm run functions:serve` | `supabase functions serve --env-file supabase/.env.local` |
| `npm run check` | `lint && typecheck && test` — the definition-of-done gate |

## Folder map (from `docs/ARCHITECTURE.md` §4)

```
docs/                          REQUIREMENTS, ARCHITECTURE, DATA_MODEL, SOLVER, UX_FLOWS, MAINTENANCE
src/
  app/                         router, providers (Query, Auth, Theme, RTL dir), shell, route guards
  pages/                       route-level components only; compose features
  components/                  shared UI; components/ui/ = shadcn primitives (generated)
  features/
    auth/ requests/ siddur/ board/ proposals/ live/ fleet/ admin/ inbox/
    <feature>/components/      React components
    <feature>/hooks/           TanStack Query hooks
    <feature>/api.ts           the only place a feature calls supabase.from / rpc
    <feature>/schema.ts        zod schemas + inferred form types
  solver/                      PURE TS (see docs/SOLVER.md §3)
    index.ts                   solve(), matchFreedSlot(), tryAutoApprove()
    types.ts normalize.ts seats.ts timeline.ts assign.ts flex.ts merge.ts split.ts improve.ts suggest.ts
    policy/engine.ts           scoreRequests(): Σ weight × normalized rule value
    rules/index.ts             ruleRegistry (const object); rules/types.ts (Rule<P>, RuleContext<P>)
    rules/<type>.ts            one rule per type (camelCase: rideType, distance, publicTransport, ...)
    rules/__tests__/           rule tests
    reasons.ts                 Hebrew reason templates keyed by reasonCode
    __fixtures__/ __tests__/   golden fixtures (<name>.input.json / .expected.json), property tests
  i18n/he.ts                   canonical UI dictionary; `export type Dictionary = typeof he`
  integrations/supabase/       client.ts (anon key), types.ts (GENERATED)
  lib/                         time.ts (TZ), week.ts, enums.ts, errors.ts (SQLSTATE → he key), push.ts, whatsapp.ts
  hooks/                       cross-feature: useSession, useRole, useDepartment
  types/                       domain types shared by UI and solver adapters (not DB rows)
supabase/
  migrations/YYYYMMDDHHMMSS_short_name.sql   hand-written; initial plan = 18 files 20260907090000_extensions_and_enums … 20260907091700_views (DATA_MODEL §6)
  seed.sql                     Supabase CLI default seed (departments, ride_types, destinations, default policy, notification_templates, demo data)
  functions/                   push-dispatch, answer-proposal, solve, on-ride-cancelled, _shared/
  tests/rls_spec.sql           every table has RLS; no `true` qual on writes
  config.toml
e2e/                           Playwright: submit-request, solve-and-publish, proposal-accept-deeplink, cancel-freed-slot
scripts/                       bundle-solver, gen-types
.claude/skills/<name>/SKILL.md routine-change playbooks (table below)
.claude/agents/<name>.md       subagents
```

## Conventions

**Naming**
- Files: `kebab-case.ts` modules, `PascalCase.tsx` components. Unit tests co-located as `*.test.ts`, except the solver which uses `__tests__/` (SOLVER.md §7).
- SQL: tables plural snake_case (`requests`, `rides`, `ride_requests` = ride↔request join, `policy_versions`), enums singular snake_case (`request_status`, `week_phase`, `notification_event`), FK columns `<singular>_id`, week key `week_start date`.
- Migrations: `YYYYMMDDHHMMSS_verb_object.sql` (Supabase CLI form; `supabase db push` orders by timestamp), one concern per file; `alter type … add value` always alone in its file; never rename or edit a committed file.
- Rule types: camelCase strings (`rideType`, `peopleServed`); reason codes: `UPPER_SNAKE` (`PLACED_SHIFTED`).
- Hooks `use<Thing>Query` / `use<Thing>Mutation`; query keys in `features/<f>/keys.ts`.

**Statuses / enums shared between SQL and TS**
1. Define in a migration: `create type request_status as enum (...)`; extend with `alter type … add value` (never rename/remove — deprecate in DATA_MODEL).
2. `npm run db:types` → `Database['public']['Enums']['request_status']`.
3. `src/lib/enums.ts`:
   ```ts
   export const REQUEST_STATUSES = ['draft','submitted',...] as const satisfies readonly Enums<'request_status'>[];
   export type RequestStatus = (typeof REQUEST_STATUSES)[number];
   export const requestStatusSchema = z.enum(REQUEST_STATUSES);
   assertSameEnum<RequestStatus, Enums<'request_status'>>();   // compile-time, both directions
   ```
4. Hebrew labels at `he.enums.requestStatus` typed `Record<RequestStatus, string>` — a missing label fails typecheck.
5. The solver has its own plain types (`src/solver/types.ts`); the DB→solver mapping lives in the board feature (`features/board/solverInput.ts`), never inside `src/solver`.
6. Rule types: `RuleType = keyof typeof ruleRegistry`; SQL `validate_policy_rules()` lists the same strings; `/review-consistency` checks they match.

**Database (DATA_MODEL.md §0, §4)**
- Every table: `id uuid pk default gen_random_uuid()`, `created_at/updated_at timestamptz not null default now()` + `set_updated_at()`. State tables also `bump_version()` (optimistic concurrency) and `audit_row()`.
- `department_id` denormalized onto every department-scoped row; week-scoped rows carry `(department_id, week_start)` with a composite FK to `weeks`, so RLS never joins.
- Policies use `(select auth.uid())`; helpers are `security definer stable set search_path = public, pg_temp`.
- Immutable history: `policy_versions`, `siddur_versions` (`forbid_mutation()`).

**React / UI**
- `<html dir="rtl" lang="he">`. Logical Tailwind utilities only (`ms-/me-/ps-/pe-/text-start`); directional icons `rtl:rotate-180`; numbers/times in `<span dir="ltr">`.
- Forms: react-hook-form + zod from `features/<f>/schema.ts`; enum options iterate `src/lib/enums.ts`, labels from `he.enums.*`.
- Data: TanStack Query only; mutations pass `expected_version` for rides/requests/proposals and surface `stale_version` conflicts via `lib/errors.ts`.
- Role gating via `useRole()` mirrors RLS; RLS is the guarantee.

**Solver (SOLVER.md §4)**
- `Rule<P> = { type, normalization: 'unit'|'minmax', defaultParams, validateParams(raw): P, describe(params): string /* Hebrew */, score(ctx, request): number }`; registered in `ruleRegistry`. Unknown types in a policy → warning `UNKNOWN_RULE_TYPE`, never a crash.
- Output carries `reasonCode` + Hebrew `reason` rendered by `reasons.ts`.

## Where to look for what

| Question | Look at |
|---|---|
| What should the system do? | `docs/REQUIREMENTS.md` (cite sections: `REQ §7.3`) |
| Tables, enums, RLS matrix, migration plan | `docs/DATA_MODEL.md` §2, §3, §4.3, §6 |
| Request / proposal / week / ride states | REQ §5.2, §7.3, §4; `ARCHITECTURE.md` §5; `src/lib/enums.ts` |
| Rule types, scoring, suggestion order | `docs/SOLVER.md` §4.3, §3.11; `src/solver/rules/` |
| Notification events (canonical list + copy), pipeline, templates | `UX_FLOWS.md` §6 (canonical 18 events); `ARCHITECTURE.md` §9; `DATA_MODEL.md` §3.11 (`enqueue_notification`, `notifications`, `push_outbox`, `notification_templates`); REQ §9 |
| Weekly cycle, cron | REQ §4; `ARCHITECTURE.md` §10 (`app.tick()`); `DATA_MODEL.md` `department_settings`, `weeks`, §6 step 17 `20260907091600_cron.sql` |
| Suggestion kind → proposal type | `SOLVER.md` §3.15 |
| Screens, routes, Hebrew copy, i18n key plan | `docs/UX_FLOWS.md` §2.1 routes, §3–5 screens, §6 notification/WhatsApp copy, §10 i18n keys; `src/i18n/he.ts` |
| Security, deep-link token | `ARCHITECTURE.md` §8 |
| Routine change recipes | `.claude/skills/*/SKILL.md`, `docs/MAINTENANCE.md` |

## Task → skill

| Task | Skill | Suggested agent |
|---|---|---|
| New priority rule type (e.g. seniority) | `/add-priority-rule` | solver-dev, then db-migrator + ui-dev |
| New field on ride requests | `/add-request-field` | db-migrator, ui-dev |
| New notification event | `/add-notification-event` | db-migrator, ui-dev |
| Any schema change | `/add-migration` | db-migrator |
| Add / edit destinations | `/manage-destinations` | db-migrator or none (admin UI) |
| Change cycle defaults, cron, reminders | `/change-weekly-cycle-defaults` | db-migrator |
| Anything else / pre-merge audit | `/new-feature-checklist` | (plan first) |
| Docs vs code drift | `/review-consistency` | docs-keeper |
| Playwright coverage | — | e2e-tester |

## To be verified once the code lands

Delete each line when confirmed.

- [ ] `package.json` scripts match the Commands table.
- [ ] Folder map matches `src/` and `supabase/`.
- [ ] Rule interface / `ruleRegistry` export names; test location `rules/__tests__/`.
- [ ] Every skill's "Files to touch" paths.

## Consistency decisions (2026-09-06)

Final; applied across all docs, skills and agents. Do not relitigate — if code must differ, change REQUIREMENTS first.

1. Generated Supabase types live at `src/integrations/supabase/types.ts`; script `npm run db:types`; npm everywhere (no pnpm/bun).
2. Seed file is `supabase/seed.sql` (Supabase CLI default); demo seed data is described in DATA_MODEL §6.
3. Migrations use the Supabase CLI form `YYYYMMDDHHMMSS_short_name.sql`; the 18-step initial plan starts at `20260907090000_extensions_and_enums.sql` (DATA_MODEL §6).
4. `week_phase` = `open, solving, published, live, archived`; after the target week ends the week is `archived` (read-only, kept for fairness stats). No `closed`.
5. One canonical `notification_event` list: the 18 events of UX_FLOWS §6.1 (enum value = snake_case of the `notif.*` key suffix); DATA_MODEL §2 and ARCHITECTURE §9 list exactly those; REQ §9 prose names nothing outside it.
6. Notification plumbing: `enqueue_notification(...)` writes one `notifications` row (inbox) plus one `push_outbox` row per active push subscription; pg_net/`drain_push_outbox()` deliver via the `push-dispatch` edge function with retries and 404/410 pruning; mutes in `profiles.muted_events notification_event[]` (Sadran-role events unmutable while assigned, enforced in enqueue); copy in the admin-editable `notification_templates` table (event, channel, variant, title, body) seeded from UX_FLOWS §6. No `notification_prefs`, no templates in `app_settings`.
7. Exactly one pg_cron entry: `app.tick()` every 15 minutes computes Asia/Jerusalem time and calls `advance_week_phases()`, `send_due_reminders()`, `expire_proposals()`, `drain_push_outbox()`, `housekeeping()`; the daily GitHub Actions keep-alive stays.
8. Requests are created/edited only via the `submit_request(payload jsonb)` SECURITY DEFINER RPC (validates §5.3, computes `is_late`, duplicate warning, versioning, audit; in `live` weeks calls `try_auto_approve`). Members SELECT own requests directly; no direct INSERT/UPDATE policies on `requests`.
9. `/p/<token>` answering needs no sign-in: random 128-bit secret stored hashed on `proposals`/`proposal_parties`, single-purpose, expires with the proposal, revocable; `answer-proposal` verifies it and records `answered_via = 'token'`; with a session the full UI shows too. Rationale in ARCHITECTURE §8 (WhatsApp on iOS does not share the PWA session). The HMAC/person-bound design is gone.
10. Suggestion kind → proposal type mapping lives once in SOLVER §3.15 (shiftWithinFlex → none/applied; shiftBeyondFlex → `shift`; merge and splitLegs → `merge` with two legs; externalHint → `external`; deny → `deny`), referenced by DATA_MODEL and UX_FLOWS.
11. Seat accounting: a request's `adults` includes its own driver; a merged passenger request adds all its adults/childSeats/boosters to the host load; the host's driver counts once (SOLVER §3.3, DATA_MODEL §5.2).
12. "Ask to join" files a normal request via `submit_request` with nullable `requests.join_ride_id`; the Sadran sees the flag and converts it into a merge proposal (REQ §7.3).
13. Hebrew lives in exactly three places: `src/i18n/he.ts`, `src/solver/reasons.ts` (keyed by reasonCode), and seeded DB data (`notification_templates`, `ride_types`, `destinations`) — hard rule 3, REQ §11.
