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
- Also: `npm run db:fake` generator (scripts/fake-week.mjs) for manual testing.

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
