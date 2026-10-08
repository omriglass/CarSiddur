# CLAUDE.md — carshare-nevo

Guidance for Claude Code working in this repository.

## Overview

- Hebrew, mobile-first PWA for Kibbutz Nevo's shared car fleet: members file weekly ride requests, a Sadran (coordinator) solves, negotiates leftovers via proposals, and publishes the weekly "siddur" (סידור רכב).
- The app **proposes**; a human always decides. The solver ranks requests with a data-driven, admin-editable priority policy.
- Stack: Vite + React 18 + TypeScript strict + shadcn/ui + Tailwind + TanStack Query + react-router; Supabase (Postgres, Google Auth, RLS, Edge Functions, pg_cron); Vitest + Playwright; Cloudflare Worker (`carsiddur`, static assets) + Supabase Free. Free tiers only.
- `docs/REQUIREMENTS.md` is the source of truth for *what*; `ARCHITECTURE.md`, `DATA_MODEL.md`, `SOLVER.md`, `UX_FLOWS.md` derive from it and must never contradict it.
- **Status: implemented application.** See `docs/IMPLEMENTATION_PLAN.md` for completed work, validation and deferred items.

## Hard rules

1. **Never modify `../commucar-share`.** Read-only reference. Do not import from it, copy files from it, or run commands inside it.
2. **Docs are the source of truth and move with the code.** Any change to behavior, schema, states, enums, rule types, notifications or screens updates the relevant `docs/*.md` **in the same change**. If REQUIREMENTS.md does not cover it, add it there first (the owner reviews requirements, not code).
3. **Hebrew lives in exactly three places.** (a) `src/i18n/he*.ts` — all UI strings keyed by namespace (he.ts is canonical, merged from he.admin.ts, he.member.ts, he.sadran.ts), accessed via the `he` object or `t(key)`/`tv(key, vars)` from `src/i18n/he.ts` (there is no `useT()` hook); (b) `src/solver/reasons.ts` — solver reason templates keyed by `reasonCode` (reason codes, rule descriptions `RULE_<TYPE>_DESC`, `PolicyParamsError` messages), so the bundled solver is self-contained and rule files have no Hebrew; (c) seeded data in `supabase/seed.sql` — `notification_templates` table (push/inbox/WhatsApp title/body), `ride_types.name_he`, `destinations.name` (Hebrew place names), `weekday_labels` (Hebrew weekday letters/names used by SQL notification vars). Never inline Hebrew in components, hooks, rule files, SQL logic, or edge functions. Identifiers, comments and docs are English. **Enforced by `eslint.config.js`** (`no-restricted-syntax`, Hebrew literal/template/JSX text) with four documented file exceptions listed there (`src/sw.ts`, `parseInviteLines.ts`, `templates/lib/placeholders.ts`, generated `src/components/ui/**`); a new exception needs a comment in the file and an entry in that config.
4. **RLS on every table**, `enable` + `force`, policies per command (never `for all`), written with the helper functions in `DATA_MODEL.md` §4.2 (`is_approved()`, `is_admin()`, `member_of(dept)`, `is_sadran(dept, week_start)`, `is_sadran_any(dept)`, `can_manage_week(dept, week_start)`, `is_week_public(dept, week_start)`). Multi-row state changes go through `SECURITY DEFINER` RPCs. `anon` has no grants. Service-role keys never reach the browser. Functions have no default grants either: a migration that adds a browser-facing RPC must `grant execute … to authenticated` explicitly, everything else (internal/cron/helpers not referenced by RLS) stays closed — `rls_smoke.sql` TEST 14 enforces it.
5. **The solver stays pure.** `src/solver/**` imports nothing from React, Supabase, the DOM, `Date.now()`, `Math.random()`, or `src/i18n`. `solve(input)` returns a value; persistence is the caller's job (`apply_solver_result` RPC). Deterministic: every sort ends in an `id` tie-break. Enforced by `eslint.config.js` (`no-restricted-imports`/`-globals`/`-syntax` on `src/solver/**`) and `src/solver/__tests__/purity.test.ts`; CI fails if `supabase/functions/_shared/solver.js` is stale relative to `src/solver`.
6. **All timestamps are Asia/Jerusalem-aware.** Postgres: `timestamptz` only; `week_start date` (the Sunday) keys a week; wall-clock settings are stored as `(dow, time)` and converted inside SQL with `at time zone 'Asia/Jerusalem'`. TS: `src/lib/time.ts` (`TZ = 'Asia/Jerusalem'`, date-fns-tz); never `getHours()`/`getDay()`/`toLocale*` without it (lint error outside `time.ts`/`dayLabels.ts`). The solver never does wall-clock arithmetic — it gets epoch ms and per-day slot bounds.
7. **Before declaring anything done:** `npm run check` (lint, typecheck, unit tests) passes. Schema changes also need `npm run db:reset && npm run db:types && npm run db:schema` with the regenerated `types.ts` and `supabase/schema-current.sql` committed, and `npm run db:test`. Solver changes also need `npm run functions:bundle` (CI diff-checks the bundle). User-facing flows run the relevant Playwright spec; `npm run check:full` runs everything (needs the local stack). CI (`.github/workflows/ci.yml`) runs `check` + bundle freshness + build and the database job (migrations replay, types + schema-dump freshness, SQL suites) on every push, and e2e nightly / on demand. A change to a mapped path updates `docs/TEST_MAP.md`/`test-map.json` in the same change when it adds a screen, flow or suite; `npm run impact` tells you what to run and what to hand QA.
8. **Never hand-edit generated files:** `src/integrations/supabase/types.ts`, `src/components/ui/*` (shadcn CLI), `supabase/functions/_shared/solver.js` (built by `scripts/bundle-solver`), `supabase/schema-current.sql` (built by `npm run db:schema`). A migration that changes a function writes its full `create or replace` — never a `pg_get_functiondef` + string-replace patch; read the current definition of anything in `schema-current.sql`.
9. **Enums are defined once, in SQL**, mirrored into `src/lib/enums.ts` (see Conventions). Priority **rule types are the exception**: they are a TS registry (`src/solver/rules/index.ts`) mirrored into the SQL `validate_policy_rules()` known set.
10. **`supabase/config.toml` is the local stack's config only** (`site_url = "http://localhost:8080"` etc.) — never run `supabase config push` against the hosted project; production Auth URLs (Site URL, redirect URLs, Google provider) are set by hand in the Supabase dashboard (`docs/FREE_DEPLOYMENT.md` §5). The `production` branch is what Cloudflare's `carsiddur` Worker builds from — `main` is not; it only advances via the gated `promote` CI job after the owner approves the GitHub `production` environment (`npm run release`, `docs/RUNBOOK_ROLLBACK.md`), never a direct push.

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
| `npm run e2e:isolated -- [--head] [--keep] [playwright args]` | Same suite from a frozen snapshot of the working tree (`--head`: committed code only) on its own Vite port (8091), so edits made during the run (another agent, the owner) cannot break it; resets the one local database like `test:e2e` (`scripts/e2e-isolated.mjs`) |
| `npm run impact -- [<base-ref>]` | Change→tests→QA impact: diffs against `<base-ref>` (default `origin/main`; also `--staged`, `--files <path...>`, `--strict`), prints the affected `docs/TEST_MAP.md` areas, the exact Vitest/`db:test`/Playwright `--grep` commands, and a ready-to-paste QA checklist; `--strict` exits 2 on any changed file matching no area |
| `npm run check` | `lint && typecheck && test` — the fast definition-of-done gate |
| `npm run check:full` | `check` + `functions:bundle` + `db:test` + `test:e2e` — everything, needs `supabase start` |
| `npm run db:start` / `db:stop` | `supabase start` / `supabase stop` (Docker required) |
| `npm run db:reset` | `supabase db reset` — replays migrations + seed.sql from scratch |
| `npm run db:fake` | `node scripts/fake-week.mjs` — generates fake members/requests through `submit_request` for manual local testing (local Supabase only) |
| `npm run qa:showcase -- --out <dir> [--api <url>] [--tag <name>]` | Small fixed **showcase department** (each member/car/request shows one principle; `docs/SHOWCASE_SCENARIOS.md` lists expected outcomes and a coverage checklist for any test data); disposable stack by default, the owner's stack only with `QA_OWNER_STACK=1` when asked |
| `npm run health -- [--container <name>\|--db-url <url> --yes-remote] [--dept <id>] [--from <date>]` | Read-only database health check (`scripts/health-check.mjs`, skill `/health-check`): overlapping rides, assigned requests without a ride, driverless confirmed rides, seat/luggage violations, chain breaks, stuck proposals/outbox, lagging week phases, recent `client_errors`; exits 1 on any error-level finding. Never writes |
| `npm run db:export` | `node scripts/db-export.mjs [--local\|--linked] [--out <dir>]` — schema/data/roles dump via `supabase db dump`; `--linked` requires `--yes-remote` (FREE_DEPLOYMENT.md §8) |
| `npm run db:types` | `supabase gen types typescript --local > src/integrations/supabase/types.ts` |
| `npm run db:schema` | Regenerate `supabase/schema-current.sql` (schema-only dump of `public` from the local stack; generated, read-only reference — CI diff-checks it) |
| `npm run db:new` | `supabase migration new <name>` → `supabase/migrations/YYYYMMDDHHMMSS_<name>.sql` (CLI will prompt for name) |
| `npm run db:push` | `supabase db push` — sync pending local migrations to the remote project (after linking) |
| `npm run db:test` | Run RLS, solver persistence and TODO regression suites in the configured local Docker container; `SUPABASE_DB_CONTAINER` selects a disposable test container |
| `npm run functions:serve` | `supabase functions serve --env-file supabase/functions/.env` |
| `npm run functions:bundle` | Bundle `src/solver` into `supabase/functions/_shared/solver.js` (the only generated file there) and run the bundle test |
| `npm run release` | `node scripts/release.mjs [--dry-run\|--yes-remote\|--yes\|--skip-check\|--status] [--tag <name>]` — the one path from checked-in `main` to a pushed `vYYYY.MM.DD-n` release tag: preflight, `check`, bundle freshness, backup, migrations, changed edge functions, tag + push. `--tag v1.2` adds the owner's own alias tag on the same commit, created and pushed *after* the automatic tag (the footer shows the alias; CI only listens to the automatic pattern). Refuses to touch the hosted project without `--yes-remote`; `--dry-run` only prints the plan. Pushing the tag triggers CI; it does **not** deploy the frontend — that needs the owner's approval on CI's `promote` job (`docs/FREE_DEPLOYMENT.md` §8, `docs/RUNBOOK_ROLLBACK.md`) |
| `node scripts/check-migrations.mjs <base-ref>` | Flags a new migration (since `<base-ref>`) that drops/renames without a matching tested `supabase/rollback/<ts>_down.sql` — CI's `check` job and `npm run release` both run it (forward-fix rule, owner decision 2026-09-14 #4) |

## Folder map

```
test-map.json                  machine-readable twin of docs/TEST_MAP.md (same area ids); consumed by scripts/impact.mjs (`npm run impact`)
docs/                          REQUIREMENTS, ARCHITECTURE, DATA_MODEL, SOLVER, UX_FLOWS, MAINTENANCE, TEST_MAP (change→tests→QA impact map, by area not feature folder), TODO (owner backlog), REFACTOR_BACKLOG (code-audit findings), HARDENING_2026-09 (production hardening audit trail), RELEASES (release notes / incident log, newest first), RUNBOOK_ROLLBACK (per-layer rollback decision tree + commands)
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
    sadran/                    board (grid + drag/drop + unmet list + suggestions; the week's home screen — the old standalone dashboard was deleted, `/sadran/:dept/:week` now redirects straight to `/board`), proposals (status/list-only, no composer entry point), change log, publish; routes spread in app/router. `sadran/{board,publish,proposals,claims,log}` share the parent `sadran/api.ts`/`hooks.ts`/`keys.ts` by design — they are not separate feature folders.
    fleet/                     car status / issues (for admin)
    carCare/                   member-facing car care: report an issue, tire-fill/wash logging, only file in the feature calling `.rpc()` (`report_car_issue`, `log_car_care`)
    cars/                      member-facing single-car page (`/cars/:carId`): car details + issue/care history; reuses `features/admin/cars` forms for writes
    stats/                     department statistics dashboard; `department_stats` RPC, zod-parsed at the api boundary (no generated row type for its jsonb return)
    waitlist/                  contested waiting-list groups (`v_waitlist_groups`, `resolve_waitlist_group`, `cancel_waitlist_group`)
    rides/                     shared by siddur + sadran (R8, 2026-09-24): ridePeople, servedOf, addPassengers, passenger/notes components, ride-change + passenger RPCs (api/hooks/keys), export/weekWorkbook, invalidateWeek.ts (`invalidateWeekData()` — the one week-scoped cache refresh after a ride/request change). ESLint forbids sadran ⇄ siddur internals imports; sadran may use only siddur/api, hooks, queryKeys, RideChangeAnswers
    solverBridge/              buildSolverInput() (DB→solver mapper for board & admin policy preview)
    <feature>/components/      React components (shadcn + business logic)
    <feature>/hooks/           TanStack Query: use<X>Query, use<X>Mutation
    <feature>/api.ts           only place feature calls supabase.from() / .rpc() (lint-enforced; `src/lib/rpc.ts` is the typed wrapper)
    <feature>/schema.ts        zod schemas + inferred form types
    <feature>/keys.ts          TanStack Query key definitions
  solver/                      PURE TypeScript (no React, Supabase, i18n imports)
    index.ts                   solve(), matchFreedSlot(), tryAutoApprove()
    types.ts                   SolverInput, Request, Car, Policy, Suggestion, Assignment, UnmetRequest
    slots.ts timeline.ts relay.ts merge.ts splitLegs.ts improve.ts suggestions.ts invariants.ts seatFit.ts live.ts flexibility.ts
    travel.ts                  origins/trip types/multi-stop: originIdOf, effectiveTripType, travelBetween, legRoute(Minutes), stopEtas, chauffeurCandidates (REQ §13.93)
    policy/engine.ts           scoreRequests(): normalization + Σ weight × rule value
    rules/index.ts             ruleRegistry (exported const object)
    rules/types.ts             Rule<P> interface, RuleContext<P>
    rules/<type>.ts            one rule per type: distance, fairness, rideType, publicTransport, peopleServed, flexibilityOffered, submissionTime, manualBoost
    greedy.ts                  placement + car-choice key (shift → preference → slack → continuity → then mileage/best-fit in the order set by Policy.carChoice ('spread' default: mileage first; 'pack': best-fit first) → id)
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
    enums.ts                   single TS home for SQL enum value lists (hard rule 9): one `as const satisfies readonly Enums<'x'>[]` array + derived type + zod schema + `assertSameEnum<>()` per enum actually used in TS; `enums.test.ts` checks no duplicates and array/schema parity
    rpc.ts                     typed `rpc()` wrapper, `toAppError()` (SQLSTATE → `he.errors.*`), `showErrorToast()`
    push.ts                    push subscription helpers
    whatsapp.ts                wa.me link builder (no Hebrew; copy comes from DB)
    notificationEvents.ts      `NOTIFICATION_EVENT_META: Record<NotificationEvent, …>` (category, memberMutable, sadranRole, weekScoped) — TS mirror of the SQL `notification_event_meta` table; mute categories and inbox tabs derive from it
    xlsx.ts                    generic workbook writer (moved from sadran/export)
  hooks/                       useTheme only; session/role/department hooks live in features/auth
  types/                       domain types shared by UI and solver (not DB rows)
  main.tsx sw.ts index.css     PWA service worker, entry point, global styles
supabase/
  migrations/                  370 additive migrations, `20260907090000` through `20261011400200` (2026-10-04/05: origins, trip types, multi-stop — REQ §13.93; drafts, merged rides, detours, reservations — REQ §13.94–§13.97; QA runs 1–5 fixes and features — REQ §13.99–§13.105)
  seed.sql                     demo data: departments, ride types, destinations, default policy, templates, member invites, demo auth users (local/e2e only)
  rollback/                    tested down scripts for non-additive migrations, `<same timestamp>_down.sql` (README.md has the convention); enforced by scripts/check-migrations.mjs
  schema-current.sql           GENERATED by `npm run db:schema`: the current `public` schema (read function definitions here, not in old migrations)
  tests/                       54 SQL suites, run via `npm run db:test` (all transactional: begin … rollback)
    rls_smoke.sql              assertions: every table has forced RLS, no `using (true)` on writes, no `for all` policies
    solve_semantics.sql        solver persistence and assignment behavior
    todo_board_semantics.sql   ownership, consent, operational permissions and publication scores
    one_way_lifecycle.sql      orphan retention, volunteering, expanded merge consent and tight schedules
    notifications_semantics.sql  notification_default_url, proposal_answered recipient, ride-cancellation passenger notices, waiting-list placement
    car_care_semantics.sql     car care portal: report/tire-fill/wash, responsible-person/admin recipients
    department_stats.sql       `department_stats()` RPC figures against seeded fixtures
    hardening_semantics.sql    withdraw/confirmed-ride guard, one live freed-slot offer, stranded-request reset, closed internal functions
    multi_day_series.sql       multi-day ("series") requests: same car held across days, cascading withdraw
    request_templates.sql      repeating requests are dismissable suggestions, never auto-submitted
    upcoming_weeks.sql         `upcoming` week phase materialization and promotion to `open`
    waitlist_groups.sql        contested waiting-list groups: clustering, resolution, cancellation
    bundle_solver.test.mjs     verify bundled solver output runs in Deno
    ride_passengers.sql        named people on a Sadran reservation: RLS, seat capacity, version bump, notices
    joinable_rides.sql         `joinable_rides_for_request`: radius, day, free seat, free-text → empty, authorization
    car_mileage.sql            `car_mileage_totals`: rolling window, 2×/1× rule, cancelled/temporary exclusions
    car_chain_healing.sql      `assert_car_chain` (REQ §13.88/§13.89): a lone one-way leg widens into a chauffeur ride, a matching leg at X pairs both into relay legs, a driving companion drives, non-one-way gaps still get a relocation ride
    withdraw_settles.sql       REQ §13.90: re-solve withdraws pending proposals on replaced rides, `withdraw_request` settles proposals, a 1-member contested group auto-resolves
    day_car_swap.sql           REQ §13.92 day car swap
    department_isolation.sql   every browser-facing SECURITY DEFINER RPC called as department A with department B's ids must refuse; completeness check fails on an unclassified new RPC; `requests` status guard incl. a second-party proposal decline
    fixtures/one_way_pairing_cases.json  shared golden cases for one-way pairing, run against the solver (`src/solver/__tests__/oneWayPairingParity.test.ts`) and SQL (`scripts/test-pairing-parity.mjs`, the last step of `db:test`); `knownDivergence` cases are documented design differences
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
  admin-errors.spec.ts           /admin/errors lists client_errors for an admin; a member is redirected (REQ §13.108, E1)
  auth.spec.ts                   sign-in / onboarding
  auto-approve.spec.ts           auto-approve on a free car (live week)
  board.spec.ts                  board regression pass (fake-week data)
  board-coordination.spec.ts     one-way drop, tight edits, merge consent coordination
  board-mobile.spec.ts           board mobile header: title/week switcher, eye menu, kebab menu, undo/redo, policy chip
  car-handover.spec.ts           "!" be-back-on-time note and its mirror on /my and the ride sheet; none for a wide gap (REQ §13.108 f)
  car-care.spec.ts               report/tire-fill/wash, responsible person sees it in History, export
  car-swap.spec.ts               swap two cars' rides for a day: siddur header menu (member), board drag (Sadran), seats blocker
  department-context.spec.ts     department selector; catalogs/Maps estimates; read-only department switching
  device-setup.spec.ts           home-screen install prompt / push-permission dismissal
  export.spec.ts                 Sadran downloads the week as a Hebrew Excel workbook
  freed-slot.spec.ts             freed slot, live week, single candidate
  merge-verdict.spec.ts          merge popup enables/refuses legs from the server's merge_preview verdict (REQ §13.108 e)
  member.spec.ts                 member area flows
  multi-day.spec.ts              multi-day ("series") request: one card/badge, linked legs, cascading withdraw, board day markers
  one-way-consent.spec.ts        combined one-way consent; orphaned passenger; volunteering
  proposal.spec.ts               proposal round trip
  proposal-retry.spec.ts         resend/replace a sent proposal's token; retry a failed send
  quick-one-way.spec.ts          quick round-trip/one-way metadata persists on reopen/save
  quick-request.spec.ts          quick request from an empty slot (live week)
  repeating-requests.spec.ts     repeat-weekly template: suggestion card, snooze, use, stop repeating
  ride-editing.spec.ts           member resizes owned rides; shadow-collision driver consent
  sadran.spec.ts                 sadran flows
  siddur-mobile.spec.ts          siddur mobile header: title/week switcher, eye menu, car-now, waitlist button, archive
  smoke.spec.ts                  shell loads, RTL/Hebrew wired end to end
  upcoming-week.spec.ts          a series reaching 2 weeks out materializes an `upcoming` week; member/Sadran visibility split
  waitlist-groups.spec.ts        contested waiting-list "בדיון" block: resolve into one ride; non-participant read-only hint
  weekly-permissions.spec.ts     weekly-assigned member vs permanent Sadran board access
scripts/
  bundle-solver.mjs            esbuild solver for edge functions
  e2e-isolated.mjs             `npm run e2e:isolated` — snapshot the tree, run Playwright on :8091 with E2E_SUPABASE_WORKDIR at the snapshot
  db-schema.mjs                `npm run db:schema` — writes supabase/schema-current.sql
  test-pairing-parity.mjs      SQL side of the one-way pairing golden cases (called by test-db.mjs)
  test-db.mjs                  SQL regression runner with explicit database-container selection
  fake-week.mjs                `npm run db:fake` — generates fake members/requests via submit_request for manual local testing
  impact.mjs                   `npm run impact` — change→tests→QA impact tool; matches `git diff` paths against test-map.json's per-area globs (hand-rolled `**`/`*` matcher, no new dependency)
  release.mjs                  `npm run release` — preflight, check, backup, migrations, edge functions, release tag; refuses remote/destructive steps without `--yes-remote`
  check-migrations.mjs         `node scripts/check-migrations.mjs <base-ref>` — flags a new migration that drops/renames without a matching `supabase/rollback/<ts>_down.sql`
  impact.test.mjs              Vitest: the glob matcher, migrationContentRules, and test-map.json/docs/TEST_MAP.md area-id consistency
.claude/
  skills/                      10 playbooks with exact steps and file paths (incl. `/qa-week`, the QA simulation — docs/QA_SIMULATION.md)
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
5. The solver has its own plain types (`src/solver/types.ts`); the DB→solver mapping lives in `src/features/solverBridge/buildSolverInput.ts`, never inside `src/solver`.
6. Rule types: `RuleType = keyof typeof ruleRegistry`; SQL `validate_policy_rules()` lists the same strings; `/review-consistency` checks they match.

**Database (DATA_MODEL.md §0, §4)**
- Every table: `id uuid pk default gen_random_uuid()`, `created_at/updated_at timestamptz not null default now()` + `set_updated_at()`. State tables also `bump_version()` (optimistic concurrency) and `audit_row()`.
- `department_id` denormalized onto every department-scoped row; week-scoped rows carry `(department_id, week_start)` with a composite FK to `weeks`, so RLS never joins.
- Policies use `(select auth.uid())`; helpers are `security definer stable set search_path = public, pg_temp`.
- Immutable history: `policy_versions`, `siddur_versions` (`forbid_mutation()`).

**React / UI**
- `<html dir="rtl" lang="he">` plus a single Radix `<DirectionProvider dir="rtl">` in `src/main.tsx` (Radix primitives default to `ltr` without it — never set `dir` per component). Logical Tailwind utilities only (`ms-/me-/ps-/pe-/text-start`); directional icons `rtl:rotate-180`; numbers/times in `<span dir="ltr">`.
- Forms: react-hook-form + zod from `features/<f>/schema.ts`; enum options iterate `src/lib/enums.ts`, labels from `he.enums.*`.
- Data: TanStack Query only; mutations pass `expected_version` for rides/requests/proposals and surface `stale_version` conflicts via `lib/rpc.ts` (`toAppError`/`showErrorToast`).
- Role gating via `useRole()` mirrors RLS; RLS is the guarantee.
- Confirmations and add/edit forms rendered in a dialog go through `ConfirmDialog`/`FormDialog` (`src/components/`); every status pill (request/ride/proposal/week/car) goes through `StatusBadge` — never a hand-rolled `Dialog`+`DialogFooter` or a bare `<Badge>` for a status enum. Proposal summaries render via `ProposalSummary`.
- Navigation: build URLs with `paths.*` from `src/app/routes.ts` (`paths.sadran.board(dept, week)`, `paths.siddur(...)`, `paths.requests.new(...)`, …), never a hand-built `` `/sadran/${dept}/${week}/board` `` template string — `src/app/routes.test.ts` checks every builder against the real router patterns.
- Weekday label/date-key: use `dateKey(instant)`, `weekdayLabel(instant, style?)` and `formatDayDate(instant)` (`src/lib/time.ts` / `src/lib/dayLabels.ts`) instead of hand-writing `formatInTimeZone(x, TZ, "yyyy-MM-dd"/"i")` or indexing `he.days.long` directly. `formatDayDate` is the canonical single-date renderer — short weekday letter + geresh + `d.M`, e.g. `ד׳ 16.9` — no date is ever shown without its weekday.
- Forms: pass `useScrollToFirstError`'s `onInvalid` to `handleSubmit` (`form.handleSubmit(onSubmit, onInvalid)`, `<form ref={formRef}>`) so an invalid submit scrolls to and focuses the first bad field; custom controls carry `data-field=<rhf name>` (`src/components/useScrollToFirstError.ts`, UX_FLOWS.md §9).

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
| Notification events (canonical list + copy), pipeline, templates | `UX_FLOWS.md` §6 (canonical 25 events); `ARCHITECTURE.md` §9; `DATA_MODEL.md` §3.11 (`enqueue_notification`, `notifications`, `push_outbox`, `notification_templates`); REQ §9 |
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
| Small bug report / regression | `/bugfixer` | none (or a cheap model) |
| Playwright coverage | — | e2e-tester |
| Mock week / end-to-end QA with role-played members | `/qa-week` (docs/QA_SIMULATION.md) | QA Sadran (opus) + QA user (sonnet) |

## Owner batch 2026-10-04 — origins, three trip types, cars stay where they are left (REQ §13.93; `docs/ORIGINS_PLAN_2026-10.md`; docs/TODO.md O1–O6)

- **Requests have an origin** (`requests.origin_id`/`origin_text`, list place or free text; default `department_members.default_origin_id` via `set_my_default_origin`, else the department home). **`trip_type`** (`round_trip` הלוך-חזור / `one_way` הלוך בלבד / `drop_off` הקפצה) is the member-facing truth; `submit_request` derives the legacy `trip_shape`/`needs_car_at_destination`/`one_way_car_mode` from it (and derives `trip_type` from them for old clients). `one_way_from` is legacy only — "pick me up from X" is a `drop_off` with origin X.
- **A car stays wherever its last ride left it**, across days and weeks: no day-end rule, no relocation rides, no overnight acknowledgement (columns kept, deprecated). `cars.base_location_id` (null = home); `car_location_at()` falls back to `car_base_location()`; the solver gets `Car.startLocationId` from `car_start_locations()`. Placement only where the car is; a ride that leaves the car elsewhere needs the car's next ride to start there (`CarTimeline.isFree(…, endLocationId)`, SQL `try_auto_approve`). Board warnings only: `chainBreaks()` (a ride whose car is elsewhere) and `weekEndAway()`.
- **Healing (`assert_car_chain`) is for `drop_off` legs only**: a relay out-leg is fine when the car's next ride the same day starts at X and leaves X; else a chauffeur ride from where the car is — at the leg's origin (drop-off) or destination (pickup) — else unmet. `one_way` legs are never paired or widened. Pairing and merges need the same origin. Travel between two places: `place_travel()` / solver `travelBetween()` (stored Google route → home preset → haversine × 1.3 at 60 km/h).
- **Multi-stop rides (2026-10-05):** `request_stops` (leg `out`/`return`, position, place or free text; written only by `submit_request`'s `stops` payload), `department_settings.stop_minutes`; leg duration = route minutes (`request_leg_route_minutes()` / solver `legRouteMinutes()`), ETAs estimated (`request_stop_etas()` / `stopEtas()`); joining at any route place in order, seats for the whole ride. Form: "+ עצירה" / "+ עצירה בחזור" chips, collapsed by default.
- **Copy:** notifications use `{{route}}` rendered from seeded `text_fragments` (`route.to/from_to/via/to_via`) by `route_label()`; browser-rendered WhatsApp copy uses `src/lib/routeLabel.ts` (`he.route.*`) — keep the two worded identically. Client queries embedding `destinations` from `requests`/`rides` must name the FK (two FKs now).
- Solver suggestion `changeOrigin` → proposal type `origin` (Sadran-sent only; applying it sets the request's origin and places it).
- Running the SQL suites without touching the owner's local data: copy `supabase/` to a temp dir, change `project_id` and every port in its `config.toml` (e.g. +3000), `npx supabase start --workdir <dir>`, then `SUPABASE_DB_CONTAINER=supabase_db_<that project_id> npm run db:test` (new migrations reach it with `npx supabase migration up --workdir <dir>`). The owner's own stack only ever gets `npx supabase migration up --local`.

## Owner feedback 2026-10-05 — board drafts, merged rides, ride-detail edits (REQ §13.94; `docs/BOARD_DRAFTS_PLAN_2026-10.md`; docs/TODO.md G1–G10)

- **Drafts are `proposals` rows with `status='draft'`** (no new table): every board action that leads to a suggestion offers "טיוטה" (`DraftChoiceDialog`, `buildProposalPayload.ts`); drafts render as the result they would produce (dashed "טיוטה", `board/draftOverlay.ts`) for Sadranim only; `discard_proposal` / `withdraw_proposal`; `publication_readiness().draftProposals` and `publish_siddur` → `publication_drafts` (not bypassable); requests with a draft/sent/accepted proposal are excluded from solving and their draft windows are fixed blocks; a full re-solve keeps rides referenced by drafts/sent merges and shifts. Do not confuse with `rides.status='draft'` (= unpublished day) or `planning_conflict` / `ride_change_requests.is_planning` (published-day shadows).
- **A merge is one ride:** the base (ride dropped onto) keeps its driver, start and final place; the guest's places become route points (`ride_route()` / `v_board_rides.route`, TS twin `src/lib/rideRoute.ts`, cheapest insertion), the end grows only by the added driving; merge payloads carry legs only (`out` one way / `both`), no window. One block with "· מאוחד"; guests are draggable chips (`GuestChips.tsx`) — dropping one out unmerges (`discard_proposal` / `withdraw_proposal` / `unmerge_request`).
- **Shift proposals** may carry `car_id` for every trip type (`_shift_place_on_car`) and places/stops (ride-detail edit from the ride sheet's "מסלול"); reservations edit places directly via `edit_ride`.
- Manual handover away from the car's base is not flagged (`isHandoverPair` in `board/geometry.ts`); SQL already lets the Sadran shorten turnaround anywhere. A הקפצה with a pickup is two independent legs everywhere (solver `dropOffSplit.ts`, board `unmetLegs.ts`, SQL never auto-approves it as one block). Solver reason texts never contain ids (`src/solver/names.ts`, `reasonNames.test.ts`).

## Owner feedback 2026-10-05 (evening) — merge detours, connected legs, trip type, reservations (REQ §13.95–§13.97; docs/TODO.md H1–H5)

- **Merge validity is one rule on three sides** (SQL `_merge_check`/`merge_preview`, solver `findMergeHosts`, TS `rideRoute.ts`): the guest boards strictly before the base route's final place, alights at or before it, added driving per leg ≤ `detour_limit_minutes`/`detour_limit_km`; the ride starts earlier by the added out-leg driving and ends later by the added return-leg driving (15-minute grid). `place_travel_for_week` returns every pair of the week's places so insertion hops are priced.
- **A הקפצה's two legs on one car connect** when the requester (or a driving companion) can drive (`connect_drop_off_legs` in `assert_car_chain`; solver ranks a request's own `#out`/`#ret` pair first).
- **`set_request_trip_type`** — the Sadran changes a trip type directly (re-placed via `place_request_on_car`, else unmet; member notified). Switching to one-way keeps the return time in `requests.kept_return_at`; switching back restores it (`restored_return_at` in the result). **Switching trip type never deletes information** (REQ §13.97): return-leg stops stay in `request_stops` while one-way (inactive — every SQL route reader requires `return_at`; views expose `active` per stop; rows read from the table use `isActiveStop(stop, hasReturn)` in `src/lib/routeStops.ts`, never `.filter(isActiveStop)`); the `stops` payload is the complete list for both legs.
- **`external` = `denied` for the waiting list** (owner 2026-10-05): still unmet, still offered freed cars unless opted out. **Auto-solve retries** still-unmet requests after each pass (a car left at X unlocks trips from X); the automatic turnaround buffer is kept even at a handover (only manual placement waives it). Ride/unmet cards show the stops by name ("· דרך: …", `viaLabel`/`rideViaNames`), not a count. One-way → round trip with no known return: departure + route + 2h, return flexibility "any time that day" (REQ §13.98).
- **A reservation ("שמירת זמן" = a ride with no served request, not `auto_relocation`) is location-neutral**: `ride_is_reservation()` in SQL, `FixedRide.locationNeutral`/`CarTimeline` pass-through in the solver, `isReservation()` (`features/rides/servedOf.ts`) on the board — it holds time only and never decides where a car is.

## Owner batch 2026-10-05 (late) — QA run 1 features (REQ §13.101; docs/TODO.md "QA run 1 findings")

- **Copy per reader** (`docs/COPY_DRAFT_2026-10.md`, owner-approved): `proposal_reader_vars(proposal, profile)` gives each party its own variant + vars (`timeChange` old → new from `text_fragments` via `_time_change_line`, `joinLine`, `carLine`, …); push/inbox never embed the WhatsApp text; WhatsApp opens "היי X, אני פונה אליך בכובע של הסידור" (never "זה/זו X, הסדרן/ית"); `proposal_party_texts` renders each merge party's WhatsApp text. `external` has two variants only (`external_city` when the origin is a list place away from home — payload `external_reason:'city'` — else `external_none`); there is no "use your own car" text. Everyone on a ride gets `joined_ride` when someone joins; a ride still needing a driver uses `merge_passenger_no_driver` / `merged_no_driver`.
- **Large luggage needs a `large_trunk` car** (≤2 per car): solver `luggageCapacity` 2/0 (`UNMET_NEEDS_LARGE_TRUNK`), SQL `car_takes_luggage`, `_merge_check`, swap blocker `luggage`, board `luggageBlocks`. The field reads "ציוד רב — צריך תא מטען גדול".
- New RPCs: `set_ride_driver` (Sadran picks a volunteer driver), `withdraw_duplicate_request` / `restore_duplicate_request` (`DUPLICATE_WITHDRAWN`; the member answers "not a duplicate"), `place_on_own_car` (owner only, round trips). Published/live-day member edits go through `submit_request`: a probe returns `{needs_confirmation:'release_to_waitlist', drives_others, would_place}` and `confirm_release:true` releases the old booking (`release_request_booking`); the submit response lists `overlaps` (the form asks "cancel the other one / keep both / back"; e2e uses `submitRequestForm()` from `e2e/helpers.ts`).
- Freed cars are held for an overlapping open contested group first (`freed_slot_offers.group_id`, `matchFreedSlot(input, { priorityRequestIds })`). Fewer days for a series: `shift` proposal with `series_span` on the series head (`_apply_series_span`).

## Owner batch 2026-10-06 — QA run 2 (REQ §13.102; docs/TODO.md "QA run 2 findings")

- **A member's answer always stands:** `maybe_apply_accepted_proposal` applies an accepted proposal; if it can no longer apply (ride moved, turnaround, seats, detour) it is withdrawn via `proposal_system_withdraw(id, 'withdrawn_stale', reason)` and the Sadran is told why — tests assert the withdrawal + reason, not an error. Proposal staleness is a fingerprint (`_ride_fp`), so publishing never breaks pending answers; apply always uses the ride's current window (`window_explicit` only when the Sadran set one).
- **Split merge:** one `merge` proposal may carry legs on two rides (`legs:[{ride_id:A,leg:'out'},{ride_id:B,leg:'return'}]`); a later Sadran merge draft for the same request extends the open one. Merge refusals carry `code` (`seats`, `detour`, `boards_at_end`, `luggage`, `luggage_count`, `private_car`, `window`, `turnaround`, `already_on_ride`).
- Contested groups only hold members who start where a car is free (`request_has_free_car_at_origin`), none when no car is free; `v_waitlist_groups.members[].origin_name`. Freed cars are offered for the car's whole free gap; `place_freed_slot_request` places only missing legs. A late request sends the Sadran one notice (`late_request` variants). `submit_request` `probe_only:true` → `would_lose_booking`; `child_request_overlaps` warns parents (by child name). Publish notices list each changed ride (old → new).

## Owner batch 2026-10-06 (late) — QA run 3 (REQ §13.103)

- A הקפצה's two legs connect on one car only when the wait is not needed elsewhere (other requests overlapping the wait < shared cars) — solver `pairRelays(…, others)` and SQL `connect_drop_off_legs` use the same rule. A Sadran **car move** (`mark_car_move`, reservation dialog "העברת רכב") is a ride with no served request, `auto_relocation = true`, `pin_reason = 'CAR_MOVE'`: location-deciding (not a reservation). Members shorten a multi-day request with `shorten_series` (1..n−1 days).
- QA run 5 (REQ §13.105): **`scripts/test-api.mjs`** drives RPCs as signed-in seeded users (opt-in `QA_API=1 QA_API_URL=<api> npm run db:test`) — SQL suites run as the owner and miss API-only failures (TODO U1). The board/composer read merge times from `merge_preview` (`useMergePreview`), not the TS twin (first step of TODO U2). `notification_default_url` depends on the recipient (members never get Sadran links). Solver suggestion `chainOneWay` (complementary one-ways, Sadran-sent shift); `pickupFromCarAtX`; `join_drop_off_legs`; one-day fewer-days. Agents for a batch are split **by feature, not by layer** (fewer hand-off gaps).
- QA run 4 (REQ §13.104): a car waits at X only when not needed elsewhere for **every** pairing (`car_wait_needed_elsewhere` / solver `waitContested`); a short הקפצה (wait ≤ 2 × turnaround) is one chauffeur ride; child-seat cars go to children (solver `kidSeats`). Driverless rides are `flagged`/`NEEDS_DRIVER` (never `confirmed`); `merged` means riding in someone else's ride. Auto-fill is idempotent (`idempotent.test.ts`).
- Proposal fingerprints ignore driver/status fields (assigning a volunteer never stales a merge); a stale withdrawal tells the members who accepted. Ask-to-join is never auto-approved. **QA-finding fixes are reproduced on the QA week before they count as done** (REQ 103 e).

## Plan B and "אסתדר" (2026-10-08; REQ §13.112 a/b)

- A round trip / one-way request may carry `requests.fallback` (`none`/`alternative`/`manage`) and, for plan B, one `request_alternatives` row (drop place = `destinations.is_drop_point` list or free text, `arrive_by`, optional pickup, from the drop place or another place — then accepting creates a linked sibling request `plan_b_parent_id` for the pickup leg, cancelled with its parent) — written only by `submit_request` (`fallback`/`alternative` keys). The solver (`src/solver/alternative.ts`, after the main solve, never changing it) adds a `useAlternative` suggestion → proposal type `alternative` (Sadran-sent; accept ⇒ `_apply_alternative()` turns the request into the plan-B הקפצה, `served_by_alternative`, main trip kept in `original_main`). `manage` drops the external hints. Publishing waits for every plan-B proposal (`publication_alternatives_pending`, not bypassable). Plan-B-served requests count `alternativeServedWeight` (fairness rule param, default 0.1) in `fairness_stats()` and in the publication scores (`weight`).

## Pilot hardening + QA runs 6/7 (2026-10-07; REQ §13.108–§13.109; docs/TODO.md "Pilot hardening plan", "QA run 7 findings")

- **The server decides, the board shows:** merge legs/verdicts come from `merge_preview` per leg (`_merge_check` is the one check for preview, create, send and apply, incl. seats/luggage probe and maintenance); `dropValidity.ts` is only the instant drag highlight. Week settings via `required_turnaround_minutes()` / TS `effectiveWeekSettings()`; unknown travel = 60 min. Large luggage is yes/no (`car_takes_luggage`).
- **"!" be-back-on-time:** `v_ride_car_neighbours` (security_invoker; published days only) → `features/rides/carHandover.ts`. Members see outcomes only on published days (`features/requests/publishedOutcome.ts`). Autofill is per day (`restrictInputToDay` in `applySolve.ts`, shared with `qa:sadran autofill --day`).
- Cancelling a request releases every leg (`cancel_ride` → `release_request_booking`); an ask-to-join of a cancelled ride is released (`rides_release_join_requests`); `set_ride_driver` replaces in one step; `refresh_ride_flags()` clears stale flags; origin = destination refused; a manual move connects הקפצה legs only by the normal rule. Safety net: `scripts/test-api.mjs` in CI, `client_errors` + `/admin/errors`, `npm run health`. Fix agents in parallel own disjoint SQL functions; generated files are regenerated once at the end from a disposable stack.

## Code review 2026-09-24 (docs/TODO.md "Code review 2026-09-24 — follow-ups", R1–R14)

- **Department separation is tested, not assumed.** `supabase/tests/department_isolation.sql` calls every browser-facing SECURITY DEFINER RPC cross-department and fails on any new RPC not classified as covered/exempt — a new RPC must be added there. `requests_status_guard()` now refuses a status/status_reason change unless it comes from the requester, `can_manage_week()` of the request's own week, a service/cron caller, or `app.system_status_transition = 'on'` — internal functions/triggers that move *someone else's* request (as a system step) must set that flag and restore the previous value. `rls_smoke.sql` TEST 18 pins every column of the tables readable across departments (`app_settings`, `car_seat_configs`, `cars`, `departments`, `notification_templates`, `notification_event_meta`, `profiles` grants, `ride_types`, `weekday_labels`): a new column there fails until classified or moved to a department-scoped table (precedent `car_access_codes`).
- **Notification event properties live in one place per side:** SQL `notification_event_meta` (read by `enqueue_notification()` for mutes/Sadran bypass and by `notification_default_url()` for week links) and `src/lib/notificationEvents.ts`; a new event adds a row to both (`/add-notification-event`). Notification merging/digest is deliberately **not** built (owner 2026-09-24: not yet shown to be a problem).
- Cache refresh after a ride/request change: `invalidateWeekData(queryClient, dept, week)` (`features/rides/invalidateWeek.ts`) — that week's board, all siddur queries except other weeks' rides, all requests keys. `admin/members/hooks.ts` stays fully unscoped on purpose.
- One-way pairing: two opposite legs at X pair whenever the return leaves after the out-leg arrives — a gap shorter than the turnaround still pairs (owner 2026-09-24, REQ §13.88); the out-leg stores the gap as `turnaround_override_minutes` (solver: `CarTimeline` `relayPairId` exemption + `Assignment.turnaroundAfterMinutes`; SQL: `pair_one_way_legs`). Pairing needs a car that seats each leg (SQL `car_fits()`, owner Q8). A lone leg with no eligible driver becomes a missing-driver chauffeur ride on both sides (Q7). The one remaining documented `knownDivergence`: SQL healing never shifts a member's own times (by design). Internal functions that set `app.system_status_transition` restore the caller's value, never force it off.

## Owner batch 2026-09-15/16 (REQ §13.86–§13.91; docs/TODO.md "Owner dump 2026-09-14 (evening)", "Owner dump 2026-09-15", "Owner notes 2026-09-16")

- Bugs: Radix `DirectionProvider dir="rtl"` in `src/main.tsx` (chips/selects rendered LTR); "מאיפה?" label for return-only requests; named children counted once (`features/requests/seatCounts.ts` — the form sends seat counts *excluding* the selected children, `set_request_children()` adds them); every single date carries its weekday — TS `formatDayDate` ("ד׳ 16.9"), SQL `day_date_label()`; notification copy says "ביום ה׳ 16.9" (the word "יום" lives in the templates, `20260915130000`), and `proposalShort` never shows a raw `{{link}}`.
- One landing page for everyone (REQ §13.87): `/` and a fresh sign-in open the last opened main page (siddur or `/my`, siddur by default; `src/app/landing.ts`). **One "my rides" screen (REQ §13.91):** `/my` lists every upcoming request grouped by week with confirmed row actions (`features/requests/components/RequestRow.tsx`, `myRequestsRows.ts`, `upcoming.ts`); `/requests` redirects there; past requests only on the lazily loaded `/my/history`.
- One-way rides ask no car mode (REQ §13.88, rule made precise 2026-09-16): `profiles.does_not_drive` (profile switch + admin editor; a new `profiles` column needs an explicit column `grant select`); the stored `one_way_car_mode` is ignored for drivers. **Pairing decides the mode:** two opposite one-way legs at the same X, compatible times, an eligible driver on board each (requester or a driving companion, `drivingCompanionIds`) → two relay legs on one car, the car waits at X (away band on the board); a lone leg → a **chauffeur ride** (car home → X → home, `needs_driver`), never a car left at X. SQL: `pair_one_way_legs()` / `try_widen_one_way_leg()` inside `assert_car_chain` (`20260916100000`); solver: `chauffeurUnpairedRelayLegs`, `PLACED_CHAUFFEUR_NO_RETURNER`, `PLACED_NEEDS_DRIVER`. Non-one-way gaps still heal with an automatic relocation ride (`rides.auto_relocation`, REQ §13.89). `apply_solver_result` accepts driverless rides (`driver_id` null → `needs_driver`; `20260915140000`).
- Withdraw settles everything (REQ §13.90, `20260916110000`): pending proposals of/with the request are withdrawn, a full re-solve withdraws pending proposals on rides it replaces and detaches historical links (the production "still referenced from table proposals" error), a contested group left with one member auto-resolves onto the car.
- `npm run release -- --tag <name>` adds an owner alias tag after the automatic one. Deferred constraint triggers fire inside the SQL suites via `set constraints all immediate` flushes (they caught bugs the rolled-back suites hid).
- Parked (code freeze): planning-ahead calendar (F6), multi-destination stops (F7), לשון פנייה (N2), the proposal-apply "hashed" toast (D5 — needs the toast's detail line).

## Owner batch 2026-09-14 (REQ §13.77 bullet, §13.78 "Extended 2026-09-14", §13.80–§13.84)

- Bug fix: a single-day request is filed as a multi-day series only when the return-day picker is open and holds a later day (`features/requests/series.ts` `isSeriesSubmission`/`returnDayAfterDayChange`).
- Siddur and Sadran board hide a temporary (private) car on days it has no ride (`components/weekGridCars.ts`, shared `WeekGrid` helper; board added on the owner's same-day follow-up).
- Sadran sets a per-week request closing time (`set_week_close_at`, board kebab menu), members get `window_changed`; the "בקשה חדשה" entry point is one `NewRequestButton` with four states (`features/requests/newRequestButton.ts`).
- Statistics: utilization includes the turnaround buffer; `sharing` (people utilization, fragmentation, one-way fulfilment — no combined score), `cancellations` (same-day rate), `requestsByHour`.
- `ride_passengers` + `set_ride_passengers`: a board reservation ("שמירת זמן") can name people (first = driver); they see it on Home/siddur and are notified. Same table is the base for the future "+ נוסעים" button.
- Joinable rides before the waiting list: `joinable_rides_for_request` (haversine within `department_settings.join_radius_km`, ±120 min, preset destinations only, free seat), `JoinableRidesDialog` after a `waitlisted` submit.
- Solver mileage balance: `Car.mileageKm` from `car_mileage_totals` (4-week rolling window), reason `CAR_BALANCED_MILEAGE`; inert when no car carries `mileageKm`. Its rank against best-fit packing is the policy option `policy_versions.settings.carChoice` (`spread` default = mileage above packing, `pack` = packing above mileage), set in the admin policy editor ("בחירת רכב").
- **One passenger list per ride** (REQ §13.85): `v_board_rides.people` (driver first; sources driver/requester/companion/child/guest/added, `key` per row), `add_ride_passengers` for any department member on published/live rides, `remove_ride_person(key)` for any non-driver row; "+ נוסעים" (with "אני") replaces ask-to-join on the siddur ride sheet; `features/siddur/ridePeople.ts` is the TS reader. Board policy chip shows the live weighted-coverage score (`board/policyScore.ts`, `useBoardPolicyScores`); `department_stats.policyScore` selects weeks by target week; joinable-rides dialog shows a WhatsApp quick link (REQ §10 amended: department phones are not secrets); the new-request button is greyed with "בקשה לשבוע הבא" while next week is not open yet; edge functions return machine codes only (Hebrew-literal lint now covers `supabase/functions/**`).
- Open points for the owner are listed at the end of `docs/TODO.md`.

## Verified 2026-09-11

Refactor/launch-readiness audit pass (`docs/REFACTOR_PLAN_2026-09-11.md`); confirmed against the code:
- Hard rules 3/5/6 are lint-enforced (`eslint.config.js`): Hebrew-literal ban outside the three allowed locations (plus documented file exceptions), solver purity (`no-restricted-imports`/`-globals`/`-syntax` on `src/solver/**`), and a wall-clock-method ban outside `lib/time.ts`/`dayLabels.ts`.
- CI (`.github/workflows/ci.yml`) has three jobs: `check` (lint, typecheck, unit tests, solver-bundle-freshness diff, build) on every push; `database` (local Supabase start, generated-types-freshness diff, `db:test`) on every push; `e2e` nightly (03:00 Asia/Jerusalem) and on `workflow_dispatch`.
- Production host is the Cloudflare Worker `carsiddur` (`wrangler.jsonc`, static assets from `dist/`); `vercel.json` is gone; security headers ship from `public/_headers`.
- Measured counts: 152 migrations (`20260907090000`–`20260910100400`), 24 SQL suites, 45 tables, 14 `src/features/*` folders, 4 edge functions, 120 Vitest files / 763 tests, 27 Playwright specs.
- A root `src/app/ErrorScreen.tsx` catches render exceptions (`errorElement`) and an `unhandledrejection` handler toasts via `showErrorToast` (UX_FLOWS.md "Error screen").
- `npm run db:export` (`scripts/db-export.mjs`) backs up the hosted project (schema/data/roles dumps with a remote guard); `npm run check:full` = `check && functions:bundle && db:test && test:e2e`.
- Plan / audit trail: `docs/REFACTOR_PLAN_2026-09-11.md` (owner decisions, open questions, remaining items).

## Verified 2026-09-09

Cleanup pass (see `docs/IMPLEMENTATION_PLAN.md` "Cleanup pass — 2026-09-09" and `docs/REFACTOR_BACKLOG.md`); confirmed against the code:
- `RequestForm` is now the one request form (`variant: 'weekly'|'quick'`); `QuickRequestSheet` composes it instead of maintaining a second implementation.
- New proposals are created only from the board (a suggestion action or drag); the proposals list is read/status-only, no composer entry point.
- A proposal answer is binary — accept or decline; anything else is a WhatsApp conversation with the Sadran, not a third button or free-text note.
- `notification_default_url()` (SQL) computes `_data.url` once inside `enqueue_notification()`; the inbox and the service worker both read it instead of each guessing a deep link.
- Published-week auto-approve: a round-trip request against an already-published week now runs `try_auto_approve()` immediately (previously live-week only); waiting-list entry returns `car_was_free: true` when placement succeeds instead of forcing `waitlisted`.
- Named children (`request_children` → `children.full_name`) now reach `v_board_rides`/`v_my_requests` and the member-facing siddur/request cards, not just the board.
- `e2e/fixtures/*` no longer exists — replaced by top-level `e2e/helpers.ts`, `global-setup.ts`, `published-week.ts` and 16 flat `*.spec.ts` files (folder map above).

## Consistency decisions (2026-09-06)

Final; applied across all docs, skills and agents. Do not relitigate — if code must differ, change REQUIREMENTS first.

1. Generated Supabase types live at `src/integrations/supabase/types.ts`; script `npm run db:types`; npm everywhere (no pnpm/bun).
2. Seed file is `supabase/seed.sql` (Supabase CLI default); demo seed data is described in DATA_MODEL §6.
3. Migrations use the Supabase CLI form `YYYYMMDDHHMMSS_short_name.sql`; the 18-step initial plan starts at `20260907090000_extensions_and_enums.sql` (DATA_MODEL §6).
4. `week_phase` = `upcoming, open, solving, published, live, archived`; after the target week ends the week is `archived` (read-only, kept for fairness stats). No `closed`. `upcoming` (2026-09-10, REQ §13.77) is a `weeks` row materialized early — by `ensure_upcoming_week()` from `submit_series_request()` — for a week beyond the department's normal opening horizon that a multi-day series leg needs; it is invisible to members, closed to ordinary requests, and promoted to `open` automatically at its normal opening time.
5. One canonical `notification_event` list: the 26 events of UX_FLOWS §6.1 (incl. `car_care`, 2026-09-09; `waitlist_contested` + `waitlist_resolved`, 2026-09-10; `window_changed`, 2026-09-14; `car_swapped`, 2026-09-24) (enum value = snake_case of the `notif.*` key suffix); DATA_MODEL §2 and ARCHITECTURE §9 list exactly those; REQ §9 prose names nothing outside it.
6. Notification plumbing: `enqueue_notification(...)` writes one `notifications` row (inbox) plus one `push_outbox` row per active push subscription; pg_net/`drain_push_outbox()` deliver via the `push-dispatch` edge function with retries and 404/410 pruning; mutes in `profiles.muted_events notification_event[]` (Sadran-role events unmutable while assigned, enforced in enqueue); copy in the admin-editable `notification_templates` table (event, channel, variant, title, body) seeded from UX_FLOWS §6. No `notification_prefs`, no templates in `app_settings`.
7. Exactly one pg_cron entry: `app.tick()` every 15 minutes computes Asia/Jerusalem time and calls `advance_week_phases()`, `send_due_reminders()`, `expire_proposals()`, `drain_push_outbox()`, `housekeeping()`; there is no keep-alive workflow — `docs/FREE_DEPLOYMENT.md` §9 explicitly says not to rely on one, and the Supabase Free project may pause after a week of API inactivity (owner-accepted, un-pause manually in the dashboard).
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
25. **Contested waiting-list groups replace first-come-first-served (2026-09-10).** Publishing a day auto-approves every unresolved round-trip request a free shared car can take; whatever is left is clustered by window overlap and, when a cluster cannot be served *in full*, becomes one `waitlist_groups` row — everyone in it is notified at once (`waitlist_contested`), the siddur and board show one **"בדיון: x, y, z"** block from the earliest departure to the latest return, and any participant *or* the Sadran settles it by ticking who rides (`resolve_waitlist_group`, first ticked = driver, one combined ride; the unticked stay `waitlisted`). The Sadran may also drop it (`cancel_waitlist_group`). A later waitlisted round trip on a published day joins an overlapping open group, or pairs with another lone waitlisted round trip. Unresolved requests therefore no longer block publication — `publication_readiness().incompleteAssignments` (an assigned/merged request whose legs are not all covered) does. (REQ §13.75; DATA_MODEL §3.10/§7.4a; UX_FLOWS §3.5/§4.2/§4.5/§6.1)
