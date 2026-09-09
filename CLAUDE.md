# CLAUDE.md — carshare-nevo

Guidance for Claude Code working in this repository.

## Overview

- Hebrew, mobile-first PWA for Kibbutz Nevo's shared car fleet: members file weekly ride requests, a Sadran (coordinator) solves, negotiates leftovers via proposals, and publishes the weekly "siddur" (סידור רכב).
- The app **proposes**; a human always decides. The solver ranks requests with a data-driven, admin-editable priority policy.
- Stack: Vite + React 18 + TypeScript strict + shadcn/ui + Tailwind + TanStack Query + react-router; Supabase (Postgres, Google Auth, RLS, Edge Functions, pg_cron); Vitest + Playwright; Vercel Hobby. Free tiers only.
- `docs/REQUIREMENTS.md` is the source of truth for *what*; `ARCHITECTURE.md`, `DATA_MODEL.md`, `SOLVER.md`, `UX_FLOWS.md` derive from it and must never contradict it.
- **Status: implemented application.** See `docs/IMPLEMENTATION_PLAN.md` for completed work, validation and deferred items.

## Hard rules

1. **Never modify `../commucar-share`.** Read-only reference. Do not import from it, copy files from it, or run commands inside it.
2. **Docs are the source of truth and move with the code.** Any change to behavior, schema, states, enums, rule types, notifications or screens updates the relevant `docs/*.md` **in the same change**. If REQUIREMENTS.md does not cover it, add it there first (the owner reviews requirements, not code).
3. **Hebrew lives in exactly three places.** (a) `src/i18n/he*.ts` — all UI strings keyed by namespace (he.ts is canonical, merged from he.admin.ts, he.member.ts, he.sadran.ts), accessed via the `he` object or `t(key)`/`tv(key, vars)` from `src/i18n/he.ts` (there is no `useT()` hook); (b) `src/solver/reasons.ts` — solver reason templates keyed by `reasonCode` (reason codes, rule descriptions `RULE_<TYPE>_DESC`, `PolicyParamsError` messages), so the bundled solver is self-contained and rule files have no Hebrew; (c) seeded data in `supabase/seed.sql` — `notification_templates` table (push/inbox/WhatsApp title/body), `ride_types.name_he`, `destinations.name` (Hebrew place names). Never inline Hebrew in components, hooks, rule files, SQL logic, or edge functions. Identifiers, comments and docs are English.
4. **RLS on every table**, `enable` + `force`, policies per command (never `for all`), written with the helper functions in `DATA_MODEL.md` §4.2 (`is_approved()`, `is_admin()`, `member_of(dept)`, `is_sadran(dept, week_start)`, `is_sadran_any(dept)`, `can_manage_week(dept, week_start)`, `is_week_public(dept, week_start)`). Multi-row state changes go through `SECURITY DEFINER` RPCs. `anon` has no grants. Service-role keys never reach the browser.
5. **The solver stays pure.** `src/solver/**` imports nothing from React, Supabase, the DOM, `Date.now()`, `Math.random()`, or `src/i18n`. `solve(input)` returns a value; persistence is the caller's job (`apply_solver_result` RPC). Deterministic: every sort ends in an `id` tie-break.
6. **All timestamps are Asia/Jerusalem-aware.** Postgres: `timestamptz` only; `week_start date` (the Sunday) keys a week; wall-clock settings are stored as `(dow, time)` and converted inside SQL with `at time zone 'Asia/Jerusalem'`. TS: `src/lib/time.ts` (`TZ = 'Asia/Jerusalem'`, date-fns-tz); never `getHours()`/`getDay()`/`toLocale*` without it. The solver never does wall-clock arithmetic — it gets epoch ms and per-day slot bounds.
7. **Before declaring anything done:** `npm run lint && npm run typecheck && npm run test` pass. Schema changes also need `npm run db:reset && npm run db:types` with the regenerated types committed. User-facing flows run the relevant Playwright spec.
8. **Never hand-edit generated files:** `src/integrations/supabase/types.ts`, `src/components/ui/*` (shadcn CLI), `supabase/functions/_shared/solver.js` (built by `scripts/bundle-solver`).
9. **Enums are defined once, in SQL**, mirrored into `src/lib/enums.ts` (see Conventions). Priority **rule types are the exception**: they are a TS registry (`src/solver/rules/index.ts`) mirrored into the SQL `validate_policy_rules()` known set.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server on `:8080` against local Supabase |
| `npm run build` | Production frontend/PWA build; run `functions:bundle` separately after solver changes |
| `npm run preview` | Preview the production build locally |
| `npm run lint` | ESLint over the entire project |
| `npm run typecheck` | `tsc --noEmit -p tsconfig.app.json` |
| `npm run test` | `vitest run` — run tests once |
| `npm run test:watch` | `vitest` — watch mode |
| `npm run test:e2e` | `playwright test` (needs `supabase start`, `db:reset`, and `npm run dev`) |
| `npm run check` | `lint && typecheck && test` — the definition-of-done gate |
| `npm run db:start` / `db:stop` | `supabase start` / `supabase stop` (Docker required) |
| `npm run db:reset` | `supabase db reset` — replays migrations + seed.sql from scratch |
| `npm run db:fake` | `node scripts/fake-week.mjs` — generates fake members/requests through `submit_request` for manual local testing (local Supabase only) |
| `npm run db:types` | `supabase gen types typescript --local > src/integrations/supabase/types.ts` |
| `npm run db:new` | `supabase migration new <name>` → `supabase/migrations/YYYYMMDDHHMMSS_<name>.sql` (CLI will prompt for name) |
| `npm run db:push` | `supabase db push` — sync pending local migrations to the remote project (after linking) |
| `npm run db:test` | Run RLS, solver persistence and TODO regression suites in the configured local Docker container; `SUPABASE_DB_CONTAINER` selects a disposable test container |
| `npm run functions:serve` | `supabase functions serve --env-file supabase/functions/.env` |
| `npm run functions:bundle` | Bundle the solver for edge functions and run the bundle test |

## Folder map

```
docs/                          REQUIREMENTS, ARCHITECTURE, DATA_MODEL, SOLVER, UX_FLOWS, MAINTENANCE, TODO (owner backlog), REFACTOR_BACKLOG (code-audit findings)
src/
  app/                         router.tsx (route patterns, all routes), routes.ts (matching path builders — `paths.sadran.*`/`paths.siddur`/`paths.requests.*`; routes.test.ts checks them against the real patterns), providers (Query, Auth, RTL), shell
  pages/                       route-level components (member, sadran, admin sections)
  components/                  shared UI; ConfirmDialog/FormDialog (dialog wrappers), StatusBadge (status pill, all kinds), SheetPortalContext; components/ui/ = shadcn primitives (auto-generated)
  features/
    auth/                      sign-in, pending approval, onboarding (guarding, token validation)
    requests/                  new/edit/submit form (RequestForm, one form for both weekly + quick variants), AddRideFab, submitOutcome.ts (shared result-toast mapping), my requests list, withdraw/cancel
    siddur/                    published week view (day list, grid), ride detail, ask-to-join
    proposals/                 components/ProposalSummary.tsx (shared one-line row, used by composer/list/`/p/:token`); proposals are created only from the board, never composed from this list
    inbox/                     notifications list, mute preferences, deep-link answering
    member/                    profile, temporary car, push subscription; routes spread in app/router
    admin/                     departments, members, roster, cars, maintenance, destinations, ride types, policies, templates, settings
    sadran/                    board (grid + drag/drop + unmet list + suggestions; the week's home screen — the old standalone dashboard was deleted, `/sadran/:dept/:week` now redirects straight to `/board`), proposals (status/list-only, no composer entry point), change log, publish; routes spread in app/router
    fleet/                     car status / issues (for admin)
    solverBridge/              buildSolverInput() (DB→solver mapper for board & admin policy preview)
    <feature>/components/      React components (shadcn + business logic)
    <feature>/hooks/           TanStack Query: use<X>Query, use<X>Mutation
    <feature>/api.ts           only place feature calls supabase.from() / .rpc()
    <feature>/schema.ts        zod schemas + inferred form types
    <feature>/keys.ts          TanStack Query key definitions
  solver/                      PURE TypeScript (no React, Supabase, i18n imports)
    index.ts                   solve(), matchFreedSlot(), tryAutoApprove()
    types.ts                   SolverInput, Request, Car, Policy, Suggestion, Assignment, UnmetRequest
    normalize.ts seats.ts timeline.ts relay.ts merge.ts splitLegs.ts improve.ts suggestions.ts invariants.ts seatFit.ts slots.ts live.ts flexibility.ts
    policy/engine.ts           scoreRequests(): normalization + Σ weight × rule value
    rules/index.ts             ruleRegistry (exported const object)
    rules/types.ts             Rule<P> interface, RuleContext<P>
    rules/<type>.ts            one rule per type: distance, fairness, rideType, publicTransport, peopleServed, flexibilityOffered, submissionTime, manualBoost
    rules/__tests__/           Vitest unit tests per rule type + registry test
    reasons.ts                 Hebrew reason templates keyed by reasonCode (sole Hebrew in solver)
    __fixtures__/              golden test fixtures (input.json, expected.json), gen.ts (fixture generator)
    __tests__/                 Vitest property + integration tests
    README.md                  solver overview
  i18n/
    he.ts                      canonical UI dictionary merged from he.admin.ts, he.member.ts, he.sadran.ts
    he.admin.ts                admin-area labels (policies, settings, tables)
    he.member.ts               member-area labels (requests, siddur, profile)
    he.sadran.ts               sadran-area labels (board, dashboard, proposals)
  integrations/supabase/
    client.ts                  supabase client (anon key)
    types.ts                   GENERATED by `npm run db:types` (committed to git)
  lib/
    time.ts                    TZ = 'Asia/Jerusalem'; formatTime, dateKey, weekdayIndex, formatWeekLabel, toJerusalem, DayBounds
    dayLabels.ts                weekdayLabel(instant, style) — kept out of time.ts so it stays i18n-free
    enums.ts                   DOCUMENTED, NOT PRESENT (2026-09-09): code imports Database['public']['Enums'] directly; owner decides (docs/TODO.md)
    rpc.ts                     typed `rpc()` wrapper, `toAppError()` (SQLSTATE → `he.errors.*`), `showErrorToast()`
    push.ts                    push subscription helpers
    whatsapp.ts                wa.me link builder (no Hebrew; copy comes from DB)
  hooks/                       useTheme only; session/role/department hooks live in features/auth
  types/                       domain types shared by UI and solver (not DB rows)
  main.tsx sw.ts index.css     PWA service worker, entry point, global styles
supabase/
  migrations/                  87 additive migrations, `20260907090000` through `20260909096000`; 7 pending a `db:reset` (2026-09-09 cleanup pass — see CLAUDE.md "Verified 2026-09-09")
  seed.sql                     demo data: departments, ride types, destinations, default policy, templates, member invites, demo auth users (local/e2e only)
  tests/
    rls_smoke.sql              assertions: every table has forced RLS, no `using (true)` on writes, no `for all` policies
    solve_semantics.sql        solver persistence and assignment behavior
    todo_board_semantics.sql   ownership, consent, operational permissions and publication scores
    one_way_lifecycle.sql      orphan retention, volunteering, expanded merge consent and tight schedules
    notifications_semantics.sql  notification_default_url, proposal_answered recipient, ride-cancellation passenger notices, waiting-list placement
    bundle_solver.test.mjs     verify bundled solver output runs in Deno
    (+ 12 more scenario suites: admin_department_membership, admin_member_fixes, coordinator_planning, department_catalogs, live_quick_one_way, member_identity, proposal_day_boundary, proposal_replacement, selected_day_publication, status_notifications, week_opening, weekly_sadran_permissions)
  functions/
    push-dispatch/             send push notifications via browser API
    answer-proposal/           token validation, proposal response (no sign-in required)
    on-ride-cancelled/         freed-slot matching via bundled solver
    destination-route/         Google Maps route/distance estimate for a destination (admin, signed-in, `can_manage_operations`)
    _shared/                   bundled solver.js (built by npm run functions:bundle)
  config.toml                  Supabase config
e2e/
  helpers.ts                   signIn/newSignedInPage, SEEDED_USERS, serviceRoleClient — shared fixtures (fixtures/* subfolder no longer exists)
  global-setup.ts               Playwright global setup
  published-week.ts             publishedFixtureWeek() helper shared by several specs
  admin.spec.ts                  admin screens; Sadran operational administration
  admin-department.spec.ts       admin joins/leaves departments via member editor; display name vs Google name
  auth.spec.ts                   sign-in / onboarding
  auto-approve.spec.ts           auto-approve on a free car (live week)
  board.spec.ts                  board regression pass (fake-week data)
  board-coordination.spec.ts     one-way drop, tight edits, merge consent coordination
  department-context.spec.ts     department selector; catalogs/Maps estimates; read-only department switching
  device-setup.spec.ts           home-screen install prompt / push-permission dismissal
  export.spec.ts                 Sadran downloads the week as a Hebrew Excel workbook
  freed-slot.spec.ts             freed slot, live week, single candidate
  member.spec.ts                 member area flows
  one-way-consent.spec.ts        combined one-way consent; orphaned passenger; volunteering
  proposal.spec.ts               proposal round trip
  proposal-retry.spec.ts         resend/replace a sent proposal's token; retry a failed send
  quick-one-way.spec.ts          quick round-trip/one-way metadata persists on reopen/save
  quick-request.spec.ts          quick request from an empty slot (live week)
  ride-editing.spec.ts           member resizes owned rides; shadow-collision driver consent
  sadran.spec.ts                 sadran flows
  smoke.spec.ts                  shell loads, RTL/Hebrew wired end to end
  weekly-permissions.spec.ts     weekly-assigned member vs permanent Sadran board access
scripts/
  bundle-solver.mjs            esbuild solver for edge functions
  test-db.mjs                  SQL regression runner with explicit database-container selection
  fake-week.mjs                `npm run db:fake` — generates fake members/requests via submit_request for manual local testing
.claude/
  skills/                      8 routine-change playbooks with exact steps and file paths
  agents/                      5 specialized agents: solver-dev, db-migrator, ui-dev, docs-keeper, e2e-tester
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
- Data: TanStack Query only; mutations pass `expected_version` for rides/requests/proposals and surface `stale_version` conflicts via `lib/rpc.ts` (`toAppError`/`showErrorToast`).
- Role gating via `useRole()` mirrors RLS; RLS is the guarantee.
- Confirmations and add/edit forms rendered in a dialog go through `ConfirmDialog`/`FormDialog` (`src/components/`); every status pill (request/ride/proposal/week/car) goes through `StatusBadge` — never a hand-rolled `Dialog`+`DialogFooter` or a bare `<Badge>` for a status enum. Proposal summaries render via `ProposalSummary`.
- Navigation: build URLs with `paths.*` from `src/app/routes.ts` (`paths.sadran.board(dept, week)`, `paths.siddur(...)`, `paths.requests.new(...)`, …), never a hand-built `` `/sadran/${dept}/${week}/board` `` template string — `src/app/routes.test.ts` checks every builder against the real router patterns.
- Weekday label/date-key: use `dateKey(instant)` and `weekdayLabel(instant, style?)` (`src/lib/time.ts` / `src/lib/dayLabels.ts`) instead of hand-writing `formatInTimeZone(x, TZ, "yyyy-MM-dd"/"i")` or indexing `he.days.long` directly.

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
| Notification events (canonical list + copy), pipeline, templates | `UX_FLOWS.md` §6 (canonical 22 events); `ARCHITECTURE.md` §9; `DATA_MODEL.md` §3.11 (`enqueue_notification`, `notifications`, `push_outbox`, `notification_templates`); REQ §9 |
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

## Verified 2026-09-06

Confirmed against the code:
- Package.json scripts (Commands table): 15 npm commands, all present and working (`db:fake` added later — see "Verified 2026-09-09")
- Folder structure: all features, pages, solver modules, i18n files exist with correct names
- Solver: ruleRegistry in rules/index.ts, 8 rule types, reasons.ts with templates, __tests__ per rule and golden fixtures in __fixtures__
- Skills: all 8 skills have correct file paths verified against actual layout (add-migration, add-priority-rule, add-request-field, add-notification-event, change-weekly-cycle-defaults, manage-destinations, review-consistency, new-feature-checklist)
- Database: 61 additive migrations from 20260907090000 through 20260907100000; seed.sql with demo data; supabase/tests/rls_smoke.sql in place
- e2e: 6 core specs (submit-request, solve-and-publish, proposal-accept-deeplink, cancel-freed-slot, auto-approve, publish), fixtures with auth/time/db helpers

## Verified 2026-09-09

Cleanup pass (see `docs/IMPLEMENTATION_PLAN.md` "Cleanup pass — 2026-09-09" and `docs/REFACTOR_BACKLOG.md`); confirmed against the code:
- `RequestForm` is now the one request form (`variant: 'weekly'|'quick'`); `QuickRequestSheet` composes it instead of maintaining a second implementation.
- New proposals are created only from the board (a suggestion action or drag); the proposals list is read/status-only, no composer entry point.
- A proposal answer is binary — accept or decline; anything else is a WhatsApp conversation with the Sadran, not a third button or free-text note.
- `notification_default_url()` (SQL) computes `_data.url` once inside `enqueue_notification()`; the inbox and the service worker both read it instead of each guessing a deep link.
- Published-week auto-approve: a round-trip request against an already-published week now runs `try_auto_approve()` immediately (previously live-week only); waiting-list entry returns `car_was_free: true` when placement succeeds instead of forcing `waitlisted`.
- Named children (`request_children` → `children.full_name`) now reach `v_board_rides`/`v_my_requests` and the member-facing siddur/request cards, not just the board.
- `e2e/fixtures/*` no longer exists — replaced by top-level `e2e/helpers.ts`, `global-setup.ts`, `published-week.ts` and 16 flat `*.spec.ts` files (folder map above).
- 7 migrations dated `20260909090000`–`20260909096000` are committed but not yet run locally; they await an owner-run `npm run db:reset && npm run db:types && npm run db:test`, then the e2e suite (see `docs/TODO.md`).

## Consistency decisions (2026-09-06)

Final; applied across all docs, skills and agents. Do not relitigate — if code must differ, change REQUIREMENTS first.

1. Generated Supabase types live at `src/integrations/supabase/types.ts`; script `npm run db:types`; npm everywhere (no pnpm/bun).
2. Seed file is `supabase/seed.sql` (Supabase CLI default); demo seed data is described in DATA_MODEL §6.
3. Migrations use the Supabase CLI form `YYYYMMDDHHMMSS_short_name.sql`; the 18-step initial plan starts at `20260907090000_extensions_and_enums.sql` (DATA_MODEL §6).
4. `week_phase` = `open, solving, published, live, archived`; after the target week ends the week is `archived` (read-only, kept for fairness stats). No `closed`.
5. One canonical `notification_event` list: the 22 events of UX_FLOWS §6.1 (incl. `car_care`, 2026-09-09) (enum value = snake_case of the `notif.*` key suffix); DATA_MODEL §2 and ARCHITECTURE §9 list exactly those; REQ §9 prose names nothing outside it.
6. Notification plumbing: `enqueue_notification(...)` writes one `notifications` row (inbox) plus one `push_outbox` row per active push subscription; pg_net/`drain_push_outbox()` deliver via the `push-dispatch` edge function with retries and 404/410 pruning; mutes in `profiles.muted_events notification_event[]` (Sadran-role events unmutable while assigned, enforced in enqueue); copy in the admin-editable `notification_templates` table (event, channel, variant, title, body) seeded from UX_FLOWS §6. No `notification_prefs`, no templates in `app_settings`.
7. Exactly one pg_cron entry: `app.tick()` every 15 minutes computes Asia/Jerusalem time and calls `advance_week_phases()`, `send_due_reminders()`, `expire_proposals()`, `drain_push_outbox()`, `housekeeping()`; the daily GitHub Actions keep-alive stays.
8. Requests are created/edited only via the `submit_request(payload jsonb)` SECURITY DEFINER RPC (validates §5.3, computes `is_late`, duplicate warning, versioning, audit; in `live` weeks calls `try_auto_approve`). Members SELECT own requests directly; no direct INSERT/UPDATE policies on `requests`.
9. `/p/<token>` answering needs no sign-in: random 128-bit secret stored hashed on `proposals`/`proposal_parties`, single-purpose, expires with the proposal, revocable; `answer-proposal` verifies it and records `answered_via = 'token'`; with a session the full UI shows too. Rationale in ARCHITECTURE §8 (WhatsApp on iOS does not share the PWA session). The HMAC/person-bound design is gone.
10. Suggestion kind → proposal type mapping lives once in SOLVER §3.15 (shiftWithinFlex → none/applied; shiftBeyondFlex → `shift`; merge and splitLegs → `merge` with two legs; externalHint → `external`; deny → `deny`), referenced by DATA_MODEL and UX_FLOWS.
11. Seat accounting: a request's `adults` includes its own driver; a merged passenger request adds all its adults/childSeats/boosters to the host load; the host's driver counts once (SOLVER §3.3, DATA_MODEL §5.2).
12. "Ask to join" files a normal request via `submit_request` with nullable `requests.join_ride_id`; on a **shared** car the Sadran sees the flag and converts it into a merge proposal (REQ §7.3).
13. Hebrew lives in exactly three places: `src/i18n/he.ts`, `src/solver/reasons.ts` (keyed by reasonCode), and seeded DB data (`notification_templates`, `ride_types`, `destinations`) — hard rule 3, REQ §11.
14. **Relay/location model**: `trip_shape` (`round_trip | one_way_to | one_way_from`) and `leg_car_mode` (`keep | relay | passenger | chauffeur`) replace the old `one_way` boolean; `rides.origin_id`/`destination_id` record where the *car* is at ride start/end; `departments.home_destination_id` is the department's home location; consecutive rides on a car must chain locations and every shared car must be home by `department_settings.day_end_time` (default 23:59) unless the Sadran acknowledges an overnight stay — enforced procedurally by `assert_car_chain()` inside every ride-writing RPC (`apply_solver_result`, `edit_ride`, …), not by a constraint (REQ §5.4, §13.57; DATA_MODEL §5 #17; SOLVER §1.3.8–9).
15. Turnaround buffer default is **30 minutes** (`department_settings.turnaround_minutes`), not 15 (REQ §13.10).
16. Fairness lookback default is **3 weeks**, the `lookbackWeeks` param of the fairness policy rule (data) — there is no department setting for it (REQ §13.18).
17. `profiles.home_week_preference` (`auto | live | open`, default `auto`) decides which week Home opens on; Home always shows upcoming rides and unserved requests above the fold regardless of the setting (REQ §5.5, §13.56).
18. Rides ending after Saturday are per-ride (`rides.overflow_allowed`, Sadran-set); there is no department-level "allow overflow" setting (REQ §13.62).
19. "Ask to join" a ride on a **temporary** car sends the merge proposal directly to the owner (the owner is the driver and decides); the Sadran only sees it in the proposals list and gets `proposal_answered` — distinct from item 12's shared-car flow (REQ §7.3, §13.43).
20. Gendered Hebrew uses **slash forms only** (נהג/ת, מקבל/ת); there is no per-member gender field — this is a final decision, not an open question (REQ §11, §13.49).

## Consistency decisions (2026-09-09)

21. **A proposal answer is binary: accept or decline.** There is no "suggest another time"/counter-proposal action and no free-text note field on `/p/:token`; anything beyond accept/decline is a WhatsApp conversation with the Sadran (REQ §13.46; UX_FLOWS §3.6).
22. **New proposals are created only from the board** (a suggestion action, or dragging a request onto a ride) — never from the proposals list, which is read/status-only (REQ §43/§7.3; UX_FLOWS §4.3).
23. **Notification URLs are computed once, in SQL, by `notification_default_url()`**, called from inside `enqueue_notification()`; both the `notifications` row (inbox) and every `push_outbox` row for the same call carry the same `data.url`, read by the inbox UI and the service worker's push handler alike — neither guesses a deep link on its own (DATA_MODEL §3.11).
24. **Waiting-list rule: always try to place a request first; waitlist only when placement is genuinely impossible.** A round-trip request against an already-published week is auto-approved exactly like a live-week one when a shared car is free; explicitly "entering the waiting list" for a published day goes through the same placement attempt and, if a car was free after all, returns `car_was_free: true` — shown as a distinct success toast, not the ordinary "waitlisted" one (REQ §66/§13.66; DATA_MODEL §6.1 "Notification links, cancellation and waiting-list follow-ups"; UX_FLOWS §18/§24).
