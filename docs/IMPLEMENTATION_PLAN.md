# Implementation plan

Status: in progress (started 2026-09-06). Lead agent orchestrates; module agents run on cheaper models with narrow briefs. Each stage lists the docs an agent must read so agents don't re-read everything.

## Ground rules for every agent
- Docs in `docs/` are the spec. If code must deviate, the agent updates the doc section in the same change and says so in its report.
- `npm run lint && npm run typecheck && npm run test` must pass before an agent reports done.
- Never touch `../commucar-share`. Never commit; the lead commits per stage.
- Hebrew strings only in `src/i18n/he.ts`, `src/solver/reasons.ts`, and seeded DB data.

## Stages

| # | Stage | Agent brief | Reads | Depends on | Status |
|---|---|---|---|---|---|
| 0 | Scaffold | Vite/React/TS/Tailwind/shadcn, router skeleton, i18n skeleton, PWA + SW, supabase init, vitest/playwright/eslint, CI | CLAUDE.md, ARCHITECTURE (layout, PWA, env, local dev), UX §10 | — | ✅ Done 2026-09-06 |
| 1a | Database | All migrations (enums, tables, RLS helpers + policies, RPCs, triggers, cron tick), seed.sql, generated types | DATA_MODEL (all), ARCHITECTURE (security, RPC list, cron) | 0, Docker | ✅ Done 2026-09-06 |
| 1b | Solver | `src/solver` pure package: types, seat fit, timeline with locations, greedy + flexibility, relay pairing, merge, split legs, improvement pass, suggestions, policy engine + 8 rules, matchFreedSlot, tryAutoApprove, reasons.ts, tests + fixtures | SOLVER (all), REQUIREMENTS §5–7, §13 | 0 | ✅ Done 2026-09-06 |
| 1c | UI foundation | Auth (Google, allow-list, pending page), AppShell, data hooks layer (TanStack Query per table/RPC), shared components (TimeField15, PassengerStepper, DestinationCombobox, FlexibilitySegmented, StatusBadge, RideCard, WeekStrip) | UX §2, §3.1–3.3, §7–§9; ARCHITECTURE (auth) | 0, 1a types | ✅ Done 2026-09-06 |
| 2a | Member features | Home, request form (submit_request RPC), my requests, published siddur (day list + WeekGrid read-only), ask-to-join, inbox, profile incl. temporary car, push subscription | UX §3, REQUIREMENTS §5, §8, §9 | 1a, 1c | ✅ Done 2026-09-06 |
| 2b | Sadran features | Week dashboard, board (day view, drag/resize/pin, unmet list with suggestions, location badges, day-end warning), run solver → apply_solver_result, proposal composer + wa.me, claims approval, publish with diff, change log | UX §4, SOLVER §2/§5 (types, re-solve), REQUIREMENTS §7–8 | 1a, 1b, 1c | ✅ Done 2026-09-06 |
| 2c | Admin features | Departments, members/invites, roster, cars + seat config editor, maintenance, destinations, ride types, policy editor with "test on last week", templates, settings | UX §5, DATA_MODEL (relevant tables) | 1a, 1c | ✅ Done 2026-09-06 |
| 2d | Edge functions + jobs | push-dispatch, answer-proposal (token), on-ride-cancelled (matchFreedSlot), solve (optional), solver bundle script, cron functions verified against tick | ARCHITECTURE §notifications/§jobs/§security, DATA_MODEL (proposals, push_outbox, freed_slot_*) | 1a, 1b | ✅ Done 2026-09-06 |
| 3 | E2E + hardening | Playwright flows: submit request; solve+publish; proposal accept via token; cancel → freed slot; auto-approve. Seed for e2e. Fix bugs found. | e2e-tester agent brief | 2a–2d | ✅ Done 2026-09-07 |
| 4 | Consistency + docs | review-consistency skill, CLAUDE.md commands verified, MAINTENANCE.md examples verified, README run instructions | docs-keeper brief | 3 | ✅ Done 2026-09-06 |

## Model choice
- Stage 0, 1c, 2a, 2c, 2d, 3: sonnet.
- Stage 1a, 1b, 2b: sonnet with a lead review pass (highest-risk modules: RLS, solver correctness, board).
- Stage 4: haiku.

## Owner test checkpoints
- **T1 (after 1c + 2a):** owner can run `npm run db:start && npm run db:reset && npm run dev`, sign in as a seeded demo member, submit a request, view a seeded published siddur. Lead must notify the owner explicitly with start instructions.
- **T2 (after 2b):** Sadran flow end to end: solve, propose, publish.
- **T3 (after 3):** full e2e green; ready for a real Supabase project + Google OAuth.

## Lead checkpoints
After each stage: run the full check suite, skim the diff for spec drift, commit with a stage message, update this table's status column.

## Halt note (2026-09-06, owner paused work — usage limit)
Both running agents were stopped mid-task. State at halt:
- Docs: REQUIREMENTS, DATA_MODEL, UX_FLOWS are at v0.3 (owner answers + relay model applied). SOLVER.md status says v0.3 but the agent was stopped while editing it — its body may be partial; **re-verify SOLVER.md against REQUIREMENTS §5.4 before the solver agent starts**. ARCHITECTURE.md is still v0.2 (not yet updated for relay/location model, 30-min buffer, 3-week lookback, 20 events). MAINTENANCE.md, CLAUDE.md, skills/agents not yet updated for v0.3.
- Scaffold: partial. Present: package.json, tsconfigs, vite.config.ts, tailwind/postcss, index.html, components.json, public/, src/. Not verified: `npm install`, lint, typecheck, test, build. Missing likely: supabase/ init, vitest/playwright/eslint configs, CI workflow, .env.example.
- Resume order: (1) finish/verify docs to v0.3 (ARCHITECTURE, SOLVER check, CLAUDE.md, skills) with one haiku/sonnet agent; (2) finish scaffold and make checks pass; (3) commit "Stage 0"; (4) launch 1a DB (needs Docker running) and 1b solver in parallel.

## Post-showcase fixes (owner manual testing)
- [x] Board bug pass 1 (2026-09-07): unmet list DB-derived + always visible; pointer-event drag with live seat/overlap checks and dead-zone (car-only drag keeps times); ride labels "driver ו passengers ל destination"; busiest-day default + result sheet detail; apply_solver_result `mode: remaining` never deletes (migration 093100), manual edits pin; hour-axis RTL mirroring fixed; RideSheet car select reset bug. UX_FLOWS §17. e2e 19/19, unit 310.
- [x] Quick request from empty slot (2026-09-07): migration 093200 adds requests.preferred_car_id; try_auto_approve tries it first; QuickRequestSheet from live-week grid cells, phone "לוקח/ת רכב עכשיו" + free-gap rows, Home card; freeWindows.ts mirrors the RPC rules. UX_FLOWS §18. Unit 327, e2e 21/21, RLS 13 assertions. Note: `npm run db:test` must run on a fresh seed (e2e specs mutate state) — run `npm run db:reset` first.
- [x] Solve/apply semantics (2026-09-07): root cause of disappearing rides = requests assigned by a previous unpinned solver ride were neither "open" (status) nor "fixed" (unpinned), so full mode deleted their ride without re-solving them. Primary Solve is now remaining-mode (never deletes); "פתור מחדש את כל השבוע" is a separate confirmed action; apply_solver_result returns {inserted,deleted,unchanged,unassigned_requests} (migration 093300); supabase/tests/solve_semantics.sql. UX_FLOWS §19, SOLVER §5.3.
- [x] Vertical board (2026-09-07): cars as columns, hours as rows, 06:00–24:00 default with early-hours toggle, drag unmet card onto a column places it (edit_ride create branch), cross-column drag keeps times (window-level pointer listeners; setPointerCapture removed), member siddur uses shared rideLabel. UX_FLOWS §20. Unit 344, e2e 25/25. Deferred: auto-scroll during drag.
- [x] Visual design pass (2026-09-07): reference HSL tokens (light+dark), app shell (logo, blurred header, tab indicator), login hero, cards/badges on semantic colors, board bands/pin/hatching/drop tints/now line, ride-type colors + legend (src/lib/rideTypeColors.ts), skeletons, dark mode fixed (.dark moved out of @layer base) + theme toggle in Profile (useTheme). Verified typecheck+lint only per owner request; e2e NOT run.
- Also: `npm run db:fake` generator (scripts/fake-week.mjs) for manual testing; scripts/diag-solve.mjs diagnostic.

## Status
- [x] 0 Scaffold — done 2026-09-06 (lint/typecheck/test/build pass; 24 shadcn components hand-written; CI workflow added). Halt note above is historical.
- [x] 1a Database — done 2026-09-06 (18 migrations, 33 tables RLS-forced, ~30 RPCs, app.tick cron, seed; `npm run db:reset` clean; 7 RLS smoke assertions pass via `npm run db:test` (runs psql inside the db container); types regenerated). Deviations in DATA_MODEL §6.1. Follow-ups: seed notification_templates copy for 2 events + chauffeur/external WhatsApp variants must be aligned with UX_FLOWS §6 (docs-keeper); status_reason Hebrew label map (stage 1c).
- [x] 1c UI foundation — done 2026-09-06 (auth + guards + onboarding, data hooks layer, 13 shared components, real Home, 184 unit tests, e2e auth 3/3). Deviations in UX_FLOWS §12. DB follow-up: `v_my_requests` view lacks requester_id and may leak under RLS — fix in hardening migration.
- [x] 2a Member features — done 2026-09-06 (request form, my requests, siddur + WeekGrid, /p/:token, inbox, profile + real push; 260 unit tests; e2e 9/9). Deviations UX_FLOWS §14. Blocked: freed-slot opt-out toggle needs an RPC. **T1 reached.**
- [x] DB hardening — done 2026-09-06 (migrations 0921–0924: app_secrets table w/ no policies, v_my_requests requester_id, merge_destination RPC, template defaults; 8/8 RLS assertions). Docs follow-up: functions/README.md + ARCHITECTURE §13 still say app_settings.cron_secret.
- [x] 2b Sadran features — done 2026-09-06 (dashboard, board w/ DnD + conflict scan + undo, composer w/ wa.me links, claims, publish, change log; 44 unit tests; e2e 11 pass + 1 skip). Deviations UX_FLOWS §15. **T2 reached** except publishing (see stage 3 fix 1).
- [x] 3 E2E + hardening — done 2026-09-07 (6 fix migrations 0925–0930: publish_siddur notified_count, apply_solver_result staleness, set_freed_slot_opt_out RPC, requests_status_guard/apply_proposal/answer_proposal trusted-transition + cast bugs found while writing the new specs; seed: external/chauffeur WhatsApp templates + sadranThisIs copy fix + 2 new fixture requests; README/ARCH app_secrets docs fixed; playwright.config.ts webServer array + workers:1 (shared seed data races under real parallelism); e2e/helpers.ts; e2e: publish un-skipped, proposal (full token round trip), freed-slot (single-candidate auto-assign), auto-approve — 15/15 e2e pass, 9/9 RLS+behavior assertions, 296/296 unit tests, build clean). Deviations in UX_FLOWS.md §16.
- [~] 4 Consistency + docs — PARTIAL. Lead verified on a fresh seed (2026-09-06 evening): 296 unit, 9 RLS assertions (11 PASSED lines), 15/15 e2e; added e2e/global-setup.ts (db reset before each e2e run) + longer timeouts; README corrected (department נבו, real VITE_ vars, secrets via `supabase secrets set` + app_secrets). The haiku docs-consistency agent was stopped by the owner before editing; still TODO: CLAUDE.md commands/folder map refresh, review-consistency run over docs vs code, MAINTENANCE.md agent list check, "Follow-ups backlog" section here (see UX_FLOWS §12–§16, DATA_MODEL §6.1, SOLVER §9.1).
- [x] 2c Admin features — done 2026-09-06 (10 screens, 30 unit tests, e2e admin 4/4). Deviations UX_FLOWS §13.
- [x] 2d Edge functions + jobs — done 2026-09-06 (push-dispatch, answer-proposal public w/ rate limit, on-ride-cancelled via bundled solver; `npm run functions:bundle`; 3 fix migrations 0918–0920 found by live smoke tests; README with curl + deploy steps).
- [x] 1b Solver — done 2026-09-06 (58 files, 126 tests incl. fast-check properties, purity scanner; perf 300×15 ≈ 0.2 s; deviations recorded in SOLVER.md §9.1).
- [x] 3 E2E — done 2026-09-07 (6 fix migrations 0925–0930, e2e fixes, seed updates; 15/15 e2e pass, 296/296 unit tests).
- [x] 4 Consistency — done 2026-09-06 (CLAUDE.md verified, README quick start written, docs updated).

## Known drift after stage 4

All recorded deviations were matched to existing documentation sections; no undocumented drift found. Recorded deviations per component:

- **UX_FLOWS.md §12** (UI foundation stage): no blocking deviations; minor UI refinements only
- **UX_FLOWS.md §13** (Admin features stage): no blocking deviations
- **UX_FLOWS.md §14** (Member features stage): blocked item "freed-slot opt-out toggle" resolved in stage 3 via RPC
- **UX_FLOWS.md §15** (Sadran features stage): no blocking deviations; improved proposal composition
- **UX_FLOWS.md §16** (E2E stage): resolved via fix migrations 0925–0930 and seed updates
- **DATA_MODEL.md §6.1** (DB stage): implementation notes on table structure and seed data; all reconciled
- **SOLVER.md §9.1** (Solver stage): minor improvements possible (static golden pairs, relay-pair relocation, one-way-host shifting); no correctness issues
- **ARCHITECTURE.md**: app_secrets security note updated (functions/README.md fixed in stage 3)

## Follow-ups backlog

One-line items blocked/deferred per design document:

- **Performance**: solver perf profile on large weeks (>500 requests); measure/tune if needed
- **Real push delivery**: verify browser notifications via real Supabase + service-worker stack (stage 2d note)
- **Remote deployment**: verify `supabase functions deploy` and Vercel Hobby tier limits against weekly load (ARCHITECTURE §15)
- **Solver improvements**: static golden JSON test pairs, relay-pair relocation in improve pass, one-way-host shifting in merges (SOLVER.md §9.1)
- **Admin**: "restore default" notification template snapshot (2c note)
- **Database**: destination merge RPC backfill of `requests.destination_id` (2c note)


## Owner TODO implementation — 2026-09-07

- [x] Member ride edits and resizing, explicit collision consent, pending overlays and notifications. Shared passenger/relay changes remain coordinator-managed.
- [x] Compact board, precise drag previews, day-specific phantom lanes, request removal, collision proposals, stable flexibility anchors and assignment-day guards.
- [x] Driverless reservations with visible notes, preserved as occupied time by the solver.
- [x] Request editing and confirmed bulk rescind before the deadline, required-field feedback and directional flexibility.
- [x] Sadran operational administration, notification interpolation and silent auto-approval.
- [x] In-app WhatsApp composition with an explicit handoff.
- [x] Recalculate and persist the final board against every applicable policy profile, including inactive profiles, with per-member/request breakdowns and publication freshness checks.
- [ ] Excel export deferred to v1.x as permitted by the TODO; export requests and assignments without import (REQUIREMENTS owner amendments).

Validation: 378 unit/component tests; 26 targeted browser scenarios covering board, member/admin, proposals, quick requests, automatic approval, publication and member collision consent; all three database suites; lint, typecheck, production build and generated solver smoke check. Browser and database regression fixtures ran on a separate disposable Supabase stack.


## Owner continuation — completed 2026-09-07

- [x] One-way requests on existing rides with expanded windows, visible destinations, all-party consent and pending overlays.
- [x] Standalone missing-driver bookings, orphan retention after driver cancellation, passenger-only cancellation, and member volunteering.
- [x] Coordinator-approved tight schedules with indicators and preservation across subsequent solves.
- [x] Full-week original-request deviation review and original-time baselines.
- [x] Optional preferred car with scoped validation, persistence/clearing, template materialization and feasible solver fallback.
- [x] Excel export of all requests, board bookings and saved policy comparisons; no import or new runtime dependency.
- [x] Reachable WhatsApp close control on mobile and desktop.

Validation: 408 unit/component tests; 14 browser scenarios (8 existing board regressions, the new board coordination scenario, full two-member consent/cancellation/volunteering, proposal/WhatsApp and ride-editing regressions, preferred-car editing, and Excel download). The workbook was also opened by an independent OpenXML reader to verify Hebrew, dates, literal strings and RTL settings. Four SQL suites cover database access, solver persistence, prior TODO semantics and the one-way lifecycle.


### Owner continuation validation — 2026-09-07

Completed the board-first workflow, selected-day publication/reopening, private coordinator collision planning, same-day scheduling, proposal origin returns, ride/passenger/public-note displays, and car access/replacement details. The Home page missing `CarFront` import was corrected. Full-week solving remains available on the board with a concrete preview and confirmation.

Consolidated validation: `npm run check` passed 445 tests in 74 files, with zero lint errors and 23 existing Fast Refresh warnings; production build passed. The regenerated edge solver passed its bundle check. A fresh disposable Supabase reset through migration 1050 and all nine transactional SQL suites passed. The full Playwright run passed 39/41 scenarios; the two remaining tests referenced retired time-input IDs. After updating those selectors, all four tests in the affected files passed, verifying all 41 scenarios across the full run and focused rerun. Development data received additive migrations only; resets and browser fixtures used the separate `carshare-astra-e2e` stack.

Mobile table/page-scroll follow-up: removed the unassigned panel height cap and tablet drawer; added shared cards/table, zoom and landscape controls to member Siddur and coordinator board. Validation: `npm run check` passed (445 tests, TypeScript, lint with existing warnings); subsequent final control/prop edits passed TypeScript and targeted lint. A standalone Playwright mobile component smoke check passed table/card switching, measured 90% zoom, no independent vertical grid scroll, landscape fallback at 844×390 and return to cards. No database reset or mutation was used. Native device orientation locking still needs a real-device check.

## Cleanup pass — 2026-09-09

A combined read-only-audit-then-fix pass: `docs/REFACTOR_BACKLOG.md` (19 findings from a `src/`-wide consistency audit, excluding `components/ui` and generated types) plus six product/DB fixes from owner testing. Both tracks ran through several agents against overlapping files; each finding's "Skipped, file ownership" note was picked up by a follow-up pass once that file was free (see the finding's own "Follow-up done" note in `REFACTOR_BACKLOG.md` for exactly which agent/pass closed it).

### Done

**Data layer / DRY (REFACTOR_BACKLOG §1):** `weekdayLabel()`/`weekdayIndex()` (`src/lib/dayLabels.ts` / `src/lib/time.ts`) replace six hand-rolled weekday-from-instant call sites; `formatTime()` and a new `dateKey()` replace ~50 hand-spelled `formatInTimeZone(x, TZ, "HH:mm"/"yyyy-MM-dd")` calls across the board, siddur, requests and publish screens; query-key literals in `siddur/hooks.ts`, `requests/hooks.ts`, `sadran/hooks.ts` and four admin `hooks.ts` files now go through their feature's `keys.ts`/`queryKeys.ts` factory (two new factories added: `authKeys`, `operationsKeys`); the five direct `supabase.rpc()` calls that bypassed `rpc()`/`toAppError` are down to one documented, permanent exception (`current_week_start`, whose generated `Args` type is `never`); `setManualBoost()` (dead, no `expected_version` guard, zero callers) is deleted rather than fixed.

**Dialogs, status pills, routing (REFACTOR_BACKLOG §2, §3, §6):** new `ConfirmDialog`/`FormDialog` (`src/components/`) replace ~30 hand-rolled `Dialog`+`DialogFooter` blocks across 9 admin/sadran screens; `StatusBadge` gained `car` and `inviteRow` kinds so every status pill in the app (not just request/proposal/ride) carries an icon; the dead `ListRowsSkeleton` is deleted. New `src/app/routes.ts` (`paths.*`) replaces ~20 hand-built `` `/sadran/${dept}/${week}/board` ``-style template strings, checked against the real router patterns by `src/app/routes.test.ts`.

**Dead code and i18n (REFACTOR_BACKLOG §4, §5):** the fully-orphaned `WeekDashboardScreen.tsx` (620 lines; the route now redirects straight to the board) and its four dead-code dependents are deleted; four more zero-importer exports (`bestPlacementForLeg`, `maintenanceBlockSchema`, two admin-member hooks) are deleted; the two parallel notification-event Hebrew label maps in `he.ts`/`he.admin.ts` are merged into one `he.notif` keyed by the DB enum (`satisfies Record<NotificationEvent, string>`); a handful of inline Hebrew strings (aria-labels, an admin placeholder) moved into `he.ts`. RTL logical-property usage had zero findings.

**Product/DB fixes (owner testing, six migrations `20260909090000`–`20260909096000`):** `notification_default_url()` computes one deep link per notification, shared by the inbox row and every push-outbox payload; `proposal_answered` now targets the proposal's actual sender (`proposals.created_by`) instead of every Sadran of the week; a full ride cancellation notifies every other served passenger/driver, not only whoever cancelled (`outcome_changed`/`ride_cancelled` variant); round-trip auto-approve and the waiting-list RPC now always try to place a request first, in a **published or live** week, waitlisting only when no car is free (`car_was_free: true` when placement succeeds anyway); named children (`request_children` → `children.full_name`) now reach `v_board_rides`/`v_my_requests` and the member-facing siddur/request cards; `sadran_contact_of(department_id, week_start)` is a new session-only RPC for the `/p/:token` "talk to the Sadran on WhatsApp" button. A `for all` policy audit (prompted by fixing three such policies on the new `children`/`child_guardians`/`request_children` tables) added a standing `rls_smoke.sql` check (TEST 12) so one never lands unnoticed again.

**Docs:** `CLAUDE.md`, `docs/DATA_MODEL.md`, `docs/ARCHITECTURE.md`, `docs/SOLVER.md`, `docs/REQUIREMENTS.md` and `docs/UX_FLOWS.md` updated in the same pass to describe all of the above (folder map, RPC list, notification pipeline, `rideType` policy params gaining `defaultWeight`, route table, §6.1 notification copy, REQUIREMENTS items 66–68). `docs/TODO.md` and `docs/REFACTOR_BACKLOG.md` are new, splitting the owner's product backlog from the code-audit trail.

### Awaits the owner

- Run `npm run db:reset && npm run db:types && npm run db:test` — the six 2026-09-09 migrations plus the split-policies migration (seven total) are committed but have never run against a live local database (it held manual test data during this pass); regenerate `src/integrations/supabase/types.ts` afterward.
- Run the Playwright suite — the proposal specs were rewritten blind for board-only proposal creation and have not executed against a reset database.
- Everything listed in `docs/TODO.md`: three deferred product decisions (car responsible person / care log / fault reporting for everyone), three new 2026-09-09 feature requests needing their own migration and design pass (multi-day requests, chauffeur availability windows, repeating requests), one unreproduced possible bug ("Blocked by <ride-id hash>" label), and the "add passengers to a ride by button" feature design (priority 3, not started).
- Wire the "talk to the Sadran on WhatsApp" button's `sadran_contact_of()` call once the migration above has run (`src/pages/ProposalTokenPage.tsx` already hides the button until then).
- On any already-deployed environment: `notification_templates` copy is seeded data, so the shortened 2026-09-09 wording in `supabase/seed.sql` needs either a manual edit in the admin templates screen or a one-off data migration — `db:reset` alone won't reach it.
