# Refactor & launch-readiness plan (audit 2026-09-11)

Read-only audit of the whole repo (frontend, SQL, solver, docs/skills, tooling), run as five
narrow read-only agents plus lead verification. Every finding below was re-checked against the
code before being listed; three agent findings were dropped as false positives (the `for all`
policies were already split by `20260909096000_split_children_write_policies.sql`; the
`rls_smoke.sql` TEST 12 check is correct; `requests/window.ts` already has a test).

Goals, in the owner's words: minimise tech debt, make maintenance easier, keep docs and skills
accurate enough for small cheap agents, prepare for launch.

Baseline at audit time: `npm run check` green (lint, typecheck, 758 unit tests in 118 files).
Deferred product items stay in `docs/TODO.md`; this file is only code/docs/tooling debt.

Each item: **size** S/M/L, **who** (agent that can do it unsupervised), acceptance check.
Groups are ordered by payoff. Inside a group, items are independent unless stated.

---

## A. Launch blockers and real rule violations

| # | Finding | Size | Who | Fix / acceptance |
|---|---|---|---|---|
| A1 | ✅ done 2026-09-11 — `דק'` moved into the `PLACED_SHIFTED`/`SUGGEST_BEYOND_FLEX` templates; purity test now scans for Hebrew; also `src/lib/rideLabel.ts` glue letters moved to `he.rideLabel`. **Hebrew inside the solver** (hard rule 3, hard rule 5 area): `` דק' `` is interpolated into reason vars at `src/solver/greedy.ts:419-420` and `src/solver/suggestions.ts:157`. | S | solver-dev | Move the unit into the `reasons.ts` templates (e.g. `{dep} דק'` in the template, pass a bare number); add the unit test that the Hebrew grep over `src/solver` minus `reasons.ts` is empty (extend `__tests__/purity.test.ts`). |
| A2 | ✅ done 2026-09-11 — `src/app/ErrorScreen.tsx` as one pathless `errorElement` over the whole tree (404 delegates to `NotFoundPage`), `unhandledrejection` → `showErrorToast`, test, UX_FLOWS §2.3. **No error boundary anywhere**: `src/app/router.tsx` has no `errorElement`, no `ErrorBoundary`, no `unhandledrejection` handler. One render exception white-screens the PWA. | M | ui-dev | Root `errorElement` with a Hebrew "something broke, reload" screen (strings in `he.ts`), plus a global rejection handler that toasts via `showErrorToast`. UX_FLOWS gets a §"Error screen". |
| A3 | ✅ done 2026-09-11 — CLAUDE.md stack line + decision 7, ARCHITECTURE §1/§8/§10/§13/§14/§15/§16 now describe the Cloudflare Worker + manual `db push`/`functions deploy`; no keep-alive workflow exists and docs say so; `vercel.json` deleted. **Deployment docs contradict reality.** Production is the Cloudflare Worker `carsiddur` (`wrangler.jsonc`, `docs/FREE_DEPLOYMENT.md`, git `824ea7e`), a hosted Supabase project is linked (`supabase/.temp/linked-project.json`). `CLAUDE.md:9`, `docs/ARCHITECTURE.md:18,506,537-593` still say Vercel and "CI applies migrations". `vercel.json` is dead config. | S | docs-keeper | Rewrite the deploy paragraphs to Cloudflare Worker + manual `supabase db push` + `functions deploy`; delete `vercel.json` (owner confirms, see Q2); move the "Vercel Hobby" cost rows to Cloudflare Free. |
| A4 | ✅ done 2026-09-11 — `public/_headers` (CSP: self + Google Fonts + `*.supabase.co`; DENY framing; nosniff; referrer; permissions). Verified with `wrangler dev` on `/`, `/my`, `/registerSW.js`. No cache rules, per FREE_DEPLOYMENT §4. `vercel.json` deleted (A3 part 1). **No security headers** on the real host (no `public/_headers`; the `vercel.json` note in `docs/TODO.md` targets the wrong host). | S | ui-dev | Add `public/_headers` with CSP (self + Supabase URL + Google fonts if used), `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `Cache-Control: no-cache` for `/sw.js` and `/manifest.webmanifest`. Verify with `npx wrangler dev` headers. Document in FREE_DEPLOYMENT §4. |
| A5 | **Schema never validated from a clean slate** since the 13 hardening migrations (`docs/TODO.md` "Waiting on…"). | M | owner runs | `npm run db:reset && npm run db:types && npm run db:test`, then `npm run test:e2e`. Commit regenerated types if they differ. Remove the TODO entry. |
| A6 | ✅ done 2026-09-11 — `scripts/db-export.mjs` (`npm run db:export -- --linked --yes-remote`; schema/data/roles dumps, remote guard), FREE_DEPLOYMENT §8 procedure. **No backup path.** Supabase Free has no automatic backups; FREE_DEPLOYMENT §8 only says "schedule exports". | S | db-migrator | Add `scripts/db-export.mjs` (`supabase db dump --linked --data-only` to a dated file) and a `db:export` npm script; document a weekly manual cadence in FREE_DEPLOYMENT §8. |
| A7 | ✅ done 2026-09-11 — untracked, `*.tsbuildinfo` ignored. **Build artifacts tracked in git**: `tsconfig.app.tsbuildinfo`, `tsconfig.sw.tsbuildinfo` (perpetual local diffs). | S | any | `git rm --cached`, add `*.tsbuildinfo` to `.gitignore`. |
| A8 | ✅ done 2026-09-11 — `.nvmrc` + `engines`. **No Node pin**: CI uses Node 20, no `.nvmrc`/`engines`. | S | any | Add `.nvmrc` = `20` and `"engines": {"node": "20.x"}`. |
| A9 | **20 inline Hebrew error strings in edge functions** (already in TODO): `push-dispatch/index.ts` (6), `answer-proposal/index.ts` (10), `on-ride-cancelled/index.ts` (9). | S | db-migrator | New `supabase/functions/_shared/errors.ts` exporting `ERRORS_HE: Record<code,string>`; call sites pass the code. Hard rule 3 gets a fourth allowed location, or the map is seeded from `notification_templates`-style DB rows (owner call, Q6). |
| A10 | ✅ done 2026-09-11 — FREE_DEPLOYMENT §2 warning + CLAUDE.md hard rule 10; `skip_nonce_check` logged in TODO.md. `supabase/config.toml` `[auth] site_url` is `localhost:8080`; `skip_nonce_check = true` unexplained. | S | docs-keeper | Add "never run `supabase config push`" to FREE_DEPLOYMENT and CLAUDE.md hard rules; add a one-line comment on `skip_nonce_check` or remove it. |

---

## B. Mechanical guardrails (turn prose rules into lint/CI so cheap agents cannot regress them)

| # | Finding | Size | Who | Fix / acceptance |
|---|---|---|---|---|
| B1 | ✅ done 2026-09-11 — five rule groups in `eslint.config.js` (disjoint file groups because flat config replaces rule options); negative probe verified all fire. ESLint enforces none of the CLAUDE.md hard rules. Solver purity is only a Vitest regex (`src/solver/__tests__/purity.test.ts`). | M | any (lead reviews) | Add to `eslint.config.js`: (1) `no-restricted-imports` + `no-restricted-syntax` for `src/solver/**` (react, supabase, i18n, `Date.now`, `Math.random`, Hebrew literals); (2) Hebrew literal ban for `src/**` outside `src/i18n/**`, `reasons.ts`, tests, and the two documented exceptions (`parseInviteLines.ts`, `templates/lib/placeholders.ts`); (3) ban `getHours/getDay/getDate/getMonth/toLocale*` outside `src/lib/time.ts`, `dayLabels.ts`; (4) `supabase.from/rpc` only in `**/api.ts`; (5) `Program`-level error on `_shared/solver.js`. A1 and D2 must land first or be fixed in the same change. |
| B2 | ✅ done 2026-09-11 — `bundle-solver.mjs` emits only `solver.js`; 28 `.d.ts` deleted; CI step `functions:bundle` + `git diff --exit-code`. CI (`.github/workflows/ci.yml`) never checks that `supabase/functions/_shared/solver.js` matches `src/solver`. A solver edit ships a stale edge-function solver silently. | S | any | CI step: `npm run functions:bundle && git diff --exit-code supabase/functions/_shared/`. Also delete the 28 tracked `_shared/**/*.d.ts` (no edge function imports them; `on-ride-cancelled` mirrors types inline) or keep them and include in the diff, owner call (Q4). |
| B3 | ✅ done 2026-09-11 — `database` job (supabase start, types diff, `db:test`) on every push; `e2e` job nightly/`workflow_dispatch`. **Unverified until the first GitHub run**; expect to tune the `-x` exclude list / env step. CI never runs `npm run db:test`, never checks `src/integrations/supabase/types.ts` freshness, never runs e2e. | M | any | Second CI job using `supabase/setup-cli` + `supabase start`: `db:reset`, `db:types` + `git diff --exit-code src/integrations/supabase/types.ts`, `db:test`. e2e as a third, `workflow_dispatch`/nightly job (workers=1 makes it ~10 min). |
| B4 | ✅ done 2026-09-11 — `check:full` script; CLAUDE.md hard rule 7 and Commands updated. No single "full" gate. `npm run check` excludes db tests and e2e; CLAUDE.md hard rule 7 implies they are manual. | S | any | Add `check:full` = `check && db:test && functions:bundle && test:e2e`; keep `check` as the fast gate. Document in CLAUDE.md Commands. |
| B5 | Route-level code splitting (`React.lazy` per admin/Sadran route) is convention only; a new heavy page silently regresses the main chunk. | S | any | `vite.config.ts` `build.chunkSizeWarningLimit` lowered to the current main chunk size + CI fails on the Vite warning (grep build output). |
| B6 | No Prettier / lint-staged; formatting is undefined. | S | any | Owner call (Q7). If yes: Prettier with defaults + `format:check` in CI. |

---

## C. Docs, skills and agent briefs (cheap-agent accuracy)

All C items are `docs-keeper` (haiku) work unless noted. Every stale token below was verified against disk.

**C1. CLAUDE.md** (S) ✅ done 2026-09-11 (docs-keeper; counts measured from disk).
- Line 9: "Vercel Hobby" → Cloudflare Worker (`carsiddur`) + Supabase Free.
- Line 104: "150 additive migrations … through `20260910100200`" → 152, through `20260910100400`.
- Lines 106-113: add the 7 unlisted SQL suites: `car_care_semantics`, `department_stats`, `hardening_semantics`, `multi_day_series`, `request_templates`, `upcoming_weeks`, `waitlist_groups`.
- Lines 56-67: add features `carCare`, `cars`, `stats`, `waitlist`; note that `sadran/{board,publish,proposals,claims,log}` share the parent `sadran/api.ts`/`hooks.ts`/`keys.ts` by design.
- Line 181 (Conventions "Statuses/enums" #5): `features/board/solverInput.ts` → `src/features/solverBridge/buildSolverInput.ts`.
- Lines 172-180 and 210: `src/lib/enums.ts` worked example contradicts line 96 ("not present"). Resolve per Q1 (implement → keep text; retire → delete the example and hard rule 9's TS half).
- Delete the "Verified 2026-09-06" section (61 migrations, six spec names that do not exist); it contradicts "Verified 2026-09-09" directly below.

**C2. Skills** (S each) ✅ done 2026-09-11 — all listed fixes plus a "variant of an existing event" section and a "re-derive counts" step; 91 path tokens verified.
- `add-priority-rule/SKILL.md:198`, `add-request-field/SKILL.md:282,292`, `manage-destinations/SKILL.md:378`: `src/features/board/…` → `src/features/solverBridge/buildSolverInput.ts`.
- `add-request-field/SKILL.md:271,272,286`: `RequestDrawer.tsx`, `TemplateForm.tsx`, `RequestCard.tsx` do not exist → point at `RequestForm.tsx`, `src/components/RideCard.tsx`, the board `RideSheet.tsx`.
- `add-notification-event/SKILL.md:96,120-123,135,148`: event count 22/21 → 24; `inbox/events.ts`, `payloads.ts`, `NotificationPreferences.tsx` do not exist → `inbox/muteCategories.ts`, `api.ts`, `hooks.ts`. Add a section "adding a *variant* of an existing event" (the `car_care`/`proposal_answered` pattern), which is the more common change.
- `change-weekly-cycle-defaults/SKILL.md:351`: `src/lib/week.test.ts` does not exist.
- `new-feature-checklist/SKILL.md:436,446-447`: `lib/errors.ts` → `lib/rpc.ts`; "four core specs" → the 27 flat specs; `npm run e2e` → `npm run test:e2e`.
- `review-consistency/SKILL.md:496,503,506`: `ruleParamForms/index.ts` → `RuleParamsEditor.tsx`; 22 rows → 24; `week_phase` list is missing `upcoming`. Add a "re-derive numeric counts" step (migrations, events, suites, specs) so the skill catches the class of error found here.
- `add-migration/SKILL.md:71`, `db-migrator.md`, `new-feature-checklist`: `rls_spec.sql` → `rls_smoke.sql`.

**C3. Agents** (S) ✅ done 2026-09-11 — counts, paths, ownership tie-breaks, lint-enforcement DoD line in every brief.
- `db-migrator.md:14` "18 events", `docs-keeper.md:21` "20 events" → 24.
- `solver-dev.md:14`, `ui-dev.md:14`: `src/features/board/` → `src/features/solverBridge/`.
- `ui-dev.md:17` feature list: drop `board`, `live`; add `carCare, cars, member, sadran, solverBridge, stats, waitlist`.
- `e2e-tester.md`: add "update the e2e table in CLAUDE.md when adding a spec".
- `docs-keeper.md`: add "re-derive counts from disk, never copy a number from another doc".
- State ownership tie-breaks: `supabase/seed.sql` (db-migrator owns; e2e-tester may add fixture rows only), `data-testid` (ui-dev adds, e2e-tester may add).

**C4. New skills the repo has many instances of but no playbook for** (M total, lead writes, sonnet drafts)
- `/add-admin-screen` (9 existing admin CRUD screens to copy from).
- `/add-rpc-end-to-end` (migration + grant + `api.ts` + hook + mutation + `expected_version` + toast mapping + SQL test).
- `/add-e2e-spec` (helpers, seeded users, `published-week.ts`, workers=1 rules).
- `/change-hebrew-copy` (i18n vs `reasons.ts` vs `notification_templates`; when a DB template edit is a migration vs seed).
- `/release` (wraps FREE_DEPLOYMENT: bundle → db push → functions deploy → Cloudflare build → hosted verification).

**C5. Docs consolidation** (S) ◐ 2026-09-11: README counts, MAINTENANCE pointer, DATA_MODEL historical notes + 20-migration addendum, IMPLEMENTATION_PLAN checkbox, WHATSAPP link in TODO done. **Open**: archive to `docs/history/` and merge root `TODO`/`todo:defered` (Q5); `SOLVER.md` auto-approve sentence (with D13); `supabase/tests/README.md` fixture contract.
- Move `IMPLEMENTATION_PLAN.md`, `HARDENING_2026-09.md`, `REFACTOR_BACKLOG.md` (all items done) to `docs/history/`; fix the stale unchecked "Excel export deferred" line first.
- Root `TODO` and `todo:defered` files: merge open items (hosted Routes API, background route refresh) into `docs/TODO.md`, delete the root files.
- Commit `docs/WHATSAPP_BOT_RESEARCH.md`; link it from `docs/TODO.md` "Deferred".
- `README.md:8,10,11,54`: 31→152 migrations, 33 tables→45, 296→758 unit tests, 6→27 specs, add `destination-route`; or replace counts with "see `npm run check`".
- `MAINTENANCE.md` "Before go-live": replace with a pointer to FREE_DEPLOYMENT (single launch checklist).
- `DATA_MODEL.md:1294,1308` historical notes say 22/18 events; mark as superseded or delete.
- `DATA_MODEL.md` §6.1: one paragraph naming the 21 unmentioned 2026-09-07/08/09 bug-fix migrations (at least `protect_last_admin`, `complete_day_readiness_and_legacy_reopen`).
- `SOLVER.md:565`: `tryAutoApprove` "powers the request form preview" has no caller; fix the sentence or wire the preview (see D13).
- `supabase/tests/README.md`: list the seed UUIDs the 21 seed-dependent SQL suites rely on (fixture contract).

---

## D. Small code debt (S each, mechanical, no behavior change)

| # | Finding | Who | Fix |
|---|---|---|---|
| D1 | ✅ done 2026-09-11 — five symbols + `sadranKeys.weekRequests` deleted. Orphaned chain: `useWeekRequests`, `useOpenWeekMutation`, `useSetWeekPhaseMutation` (`sadran/hooks.ts`) and `openWeek`, `setWeekPhase` (`sadran/api.ts`) have zero importers. | ui-dev | Delete all five. |
| D2 | ✅ done 2026-09-11 — pure `requests/dayLabel.ts` + test. `RequestForm.tsx:146-148` `dayLabel()` uses unzoned `getDay()` (hard rule 6 backslide; user-visible in the quick-request header). | ui-dev | Use `weekdayLabel(instant, 'short')` + `formatInTimeZone`. |
| D3 | ✅ done 2026-09-11 — factories used; `inboxKeys.all` added. Six raw root query-key literals bypass the factories added on 2026-09-09: `siddur/hooks.ts:44,55,85,96`, `proposals/hooks.ts:20,69`. | ui-dev | Use `siddurKeys.all`, `sadranKeys.all`, `requestsKeys.all`, `inboxKeys.all` (add if missing). |
| D4 | `trip_shape` literal array defined twice: `requests/schema.ts:16` and `components/TripShapeControl.tsx:5`. | ui-dev | One export (in `lib/enums.ts` if Q1 = implement). |
| D5 | ✅ done 2026-09-11 — `StatusBadge kind="carIssue"` (SQL enum `car_issue_status`); only `CarManageScreen` had a hand-rolled pill — `IssuesScreen` renders just the boolean "unsafe" badge, the audit was wrong about it. Car-issue status badge hand-rolled twice: `cars/components/CarManageScreen.tsx:81-82`, `admin/cars/components/IssuesScreen.tsx:56`. | ui-dev | Add `kind: 'carIssue'` to `StatusBadge`. |
| D6 | ✅ done 2026-09-11 — `admin/api.ts`, `fetchChildren` in `requests/api.ts`. `supabase.from` outside `api.ts`: `admin/operationsApi.ts:9`, `requests/children.ts:17-18`. | ui-dev | Rename `operationsApi.ts` → `admin/api.ts`; move `fetchChildren` into `requests/api.ts`. Prerequisite for B1 rule 4. |
| D7 | Query-key file naming split: 5 features use `keys.ts`, 12 use `queryKeys.ts`. | ui-dev | Rename the 5 to `queryKeys.ts`; update CLAUDE.md folder map (which says `keys.ts`). |
| D8 | `sadran/solverRun.ts` is a "compatibility shim" re-exporting `applySolve.ts`, but 10 files import the shim and none import `applySolve` directly. | ui-dev | Rename `applySolve.ts` → `solverRun.ts` (keep its test), delete the shim. |
| D9 | ✅ done 2026-09-11 — 7 dead templates deleted (the 5 listed + `PUBLICTRANSPORT_PARAMS_INVALID`, `MANUALBOOST_PARAMS_INVALID`); `reasons.test.ts` enforces both directions; SOLVER.md §3.10/§3.13/§7.1/§8 corrected. Five dead reason templates in `src/solver/reasons.ts`: `RELOCATED_FOR`, `RELOCATED_FOR_SHIFT`, `UNMET_CAR_AWAY`, `UNMET_SERIES_PARTIAL_WEEK`, `SUGGEST_MERGE_LEG`. | solver-dev | Delete, add a test that every template key is emitted somewhere and vice versa. |
| D10 | ✅ done 2026-09-11 — shared `compareUnitsByPriority` in greedy.ts, used by improve.ts; goldens unchanged. `src/solver/improve.ts:59` sorts by score only, no `submittedAtMs`/`id` tie-break (hard rule 5 determinism). | solver-dev | Reuse the comparator from `greedy.ts:80-84`. |
| D11 | ✅ done 2026-09-11 — `validatePositiveNumberParam(raw, key, code, { allowZero })`; submissionTime keeps `allowZero`. Five rules copy-paste the same positive-number `validateParams` (`distance`, `fairness`, `peopleServed`, `submissionTime`, `flexibilityOffered`). | solver-dev | `validatePositiveNumberParam(raw, key, code)` in `rules/types.ts`. |
| D12 | ◐ lib half done 2026-09-11 (`roundTo15` deleted, `ADULT_PASSENGER_AGE` unexported); `chauffeurLoad`: **keep and wire** — SOLVER.md §3.3/§3.11 item 5/§7.1 require the chauffeur suggestion to be gated on a shared car free at home with `chauffeurLoad` seat fit, and `suggestions.ts` emits it unconditionally today (behavior gap, logged in docs/TODO.md "Possible bugs"). Dead exports: `lib/time.ts` `roundTo15` (tested, no caller), `lib/childAge.ts` `ADULT_PASSENGER_AGE`, `solver/seatFit.ts` `chauffeurLoad` (only its test). | any | Delete or wire; `chauffeurLoad` was built for `SUGGEST_CHAUFFEUR` and never used there, owner call. |
| D13 | `solver/live.ts` `tryAutoApprove` has no caller; SQL `try_auto_approve` is the authority and nothing cross-checks them. | solver-dev + db-migrator | Either delete the TS copy and fix SOLVER.md §"auto-approve", or add one shared fixture asserted by both `live.test.ts` and `solve_semantics.sql`. |
| D14 | `Bearer` header parsing duplicated in `push-dispatch` and `answer-proposal`. | db-migrator | `bearerToken(req)` in `_shared/env.ts`. |
| D15 | ✅ done 2026-09-11 — `unmetStatuses.test.ts` covers every `request_status`. `sadran/unmetStatuses.ts` (the status set behind a fixed owner bug) has no test. | ui-dev | Add `unmetStatuses.test.ts`. |
| D16 | `auth/`, `fleet/`, `inbox/` features have zero unit tests; `auth` holds the role gating that mirrors RLS. | ui-dev | Tests for `useRole`-adjacent pure helpers at minimum. |

---

## E. Structural code debt (M/L, one agent per item, lead reviews the seam first)

| # | Finding | Size | Who | Seams (verified line ranges) |
|---|---|---|---|---|
| E1 | `BoardScreen.tsx` 1516 lines, 12 `useState`, ~22 nested helpers before the JSX. | L | ui-dev, 3 PRs | (a) L112-186 data hooks → `useBoardData`; (b) L194-330 + effects at 399/501 → `useSolverPreview`; (c) L674-861 pure drop-validity helpers → `board/dropValidity.ts` with unit tests; (d) L1353-1408 four inline dialogs → `BoardDialogs.tsx`. Do (c) first: pure, testable, highest bug density. |
| E2 | `RequestForm.tsx` 1124 lines. | L | ui-dev, 2 PRs | (a) L299-311 → `useRequestFormData`; (b) L449-476 quick-slot evaluation → pure `evaluateQuickSlot()` + test; (c) L639-1124 JSX → `DestinationRideTypeFields`, `DayTimeFields`, `PassengerFields`, `FlexibilityNotesFields`; (d) L510-623 → `useRequestFormSubmit`. |
| E3 | `components/WeekGrid.tsx` 794 lines; `Column` component declared inside the render body. | M | ui-dev | (a) L294-347 → `usePinchZoom`; (b) L370-517 → `useRideDragController`; (c) hoist `Column` → `WeekGridColumn.tsx`. |
| E4 | `pages/SiddurPage.tsx` 733 lines of feature logic in a page. | M | ui-dev | (a) L115-150 → `siddur/hooks` `useSiddurPageData`; (b) L182-230 move/collision → `useMemberRideMove` (share seat-fit helper with E1c); (c) L84-137 → `useDeepLinkFocus`. Same for `HomePage.tsx`, `RequestsListPage.tsx` at lower priority. |
| E5 | `requests/api.ts` 701 lines, 260 of them types; `sadran/api.ts` 608 lines for five sub-features. | M | ui-dev | Move types to `requests/types.ts`; extract pure `mapMyRequestRow`. For `sadran`, either document "sub-features share the parent api.ts" (C1) or split with a barrel. |
| E6 | `sadran/applySolve.ts` 679 lines, four concerns. | M | ui-dev | `board/servedEntries.ts` (L113-171), `board/solverContext.ts` (L172-432), `board/applyPayload.ts` (L533-644), `board/fullResolveDiff.ts` (L645-679). Do after D8. |
| E7 | 37 `as unknown as` casts, concentrated in `sadran/api.ts` (7), `requests/api.ts` (6), `cars/api.ts` (4): RPC return shapes are not typed through `lib/rpc.ts`. | M | ui-dev | `rpc<Fn extends keyof Functions>()` returning `Functions[Fn]['Returns']` with a per-RPC zod parse for `jsonb` returns; remove casts file by file. |
| E8 | `src/lib/enums.ts` absent; 30 ad hoc `Database["public"]["Enums"][…]` aliases (`RequestStatus` in 4 files, `WeekPhase` in 5, `RideStatus`/`ProposalStatus` in 4 each), 5 exhaustive maps in `StatusBadge`, 3 literal arrays. | L | ui-dev after Q1 | Implement as documented in CLAUDE.md Conventions (one `as const satisfies readonly Enums<'x'>[]` per enum + `assertSameEnum`), then replace aliases mechanically. |
| E9 | `seed.sql` mixes demo data with production catalogs; FREE_DEPLOYMENT admits there is no prod seed path. | M | db-migrator | Split `seed.sql` → `supabase/seed/catalogs.sql` (weekday_labels, ride_types, notification_templates, default policy) + `supabase/seed/demo.sql`; `config.toml [db.seed] sql_paths` lists both locally; FREE_DEPLOYMENT §6 applies only catalogs. |
| E10 | No tests for edge-function handlers; only `destination-route` has a pure `handler.ts`. | M | db-migrator | Vitest for `destination-route/handler.ts` as the template; extract handlers for the other three. |
| E11 | Function churn: `publish_siddur` redefined 8×, `submit_request` 7×, `apply_proposal` 6×, `edit_ride`/`apply_solver_result`/`expire_proposals` 5×; `v_board_rides` 7×. 152 files, 18.7k lines; the current definition of any RPC is spread across up to 8 patches. | L | db-migrator, lead reviews | **Squash to a baseline, last step before launch (owner approved 2026-09-11, hosted project holds test data only).** Procedure: (1) all other groups merged and A5 green; (2) `npm run db:reset`, then `supabase db dump --local --schema public,app,cron` (schema only) as the raw baseline; (3) split the dump by concern into ~12 files under a new timestamp prefix (`extensions_and_enums`, `identity`, `helpers`, `catalogs`, `weeks_requests`, `rides_proposals`, `notifications`, `waitlist_car_care`, `views`, `rls`, `rpc`, `grants_cron`) so a file still answers "where is X defined"; (4) delete the 152 old files; (5) `npm run db:reset && db:types && db:test && test:e2e` must be identical to before (diff `types.ts` = empty); (6) reset the hosted project (`supabase db reset --linked`) and `db push`; (7) docs: DATA_MODEL §6 becomes the 12-file table, the 105 timestamp references across `docs/*.md` become concern-file references (docs-keeper sweep), CLAUDE.md folder map and `.claude/skills/add-migration` updated. Keep the old files reachable via a git tag `pre-squash-2026-09`. |

---

## F. Explicitly not recommended

- Touching `v_board_rides`/`v_my_requests` churn; it tracks feature growth.
- Any change under `src/components/ui/*` or `types.ts` (generated).

---

## Suggested order

1. **A** (A1, A2, A4, A7, A8 are one afternoon; A5 is the owner's run; A3/A9/A10 docs).
2. **B1 + B2 + B4** immediately after A1/D2/D6 so lint is green on day one.
3. **D** in one sweep (each row is a self-contained sonnet task; D6 before B1).
4. **C** in one docs-keeper pass, after Q1/Q2 are answered.
5. **E1c, E3b, E4** first among structural items (bug density), then E7/E8, then the rest.
6. **B3** (approved).
7. **E11 squash** last, once everything above is merged and A5 is green; tag `pre-squash-2026-09` first.

## Owner decisions (2026-09-11)

- **Q1 enums — implement.** Create `src/lib/enums.ts` as documented in CLAUDE.md Conventions and migrate the 38 sites (E8). CLAUDE.md line 96 "not present" note goes away once it lands.
- **Q2 deployment — Cloudflare Worker `carsiddur` is the only production host.** Docs move to it; `vercel.json` is deleted (A3).
- **Q3 hosted data — test data only, no real members yet; owner approved squashing.** E11 becomes the final pre-launch step (procedure in the row). E9 (seed split) stays low priority until real members are onboarded, and is easier to do inside the squash.
- **Q4 CI — yes to longer, better-tested runs.** Add the Supabase-in-Docker job (B3) and the bundle/types freshness checks (B2). Delete the 28 tracked `supabase/functions/_shared/**/*.d.ts` and stop emitting them from `scripts/bundle-solver.mjs` (only `solver.js` stays; `on-ride-cancelled` already mirrors its types inline).

## Open owner questions

- **Q5** Archive `IMPLEMENTATION_PLAN.md`, `HARDENING_2026-09.md`, `REFACTOR_BACKLOG.md` under `docs/history/` and merge the two root `TODO` files into `docs/TODO.md`?
- **Q6** Edge-function Hebrew (A9): a fourth allowed Hebrew location `_shared/errors.ts`, or read messages from a DB table?
- **Q7** Client error reporting (Sentry free tier) and Prettier: add either?
