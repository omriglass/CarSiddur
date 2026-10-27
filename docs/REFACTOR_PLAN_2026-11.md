# Refactor plan — one focused week (drafted 2026-10-27)

Status: **plan only, not started.** To be run once the app behaves correctly and a week is set aside for refactors. Comes from the architecture review of 2026-10-27 (main risks: the same placement rules in SQL and TS, large procedural SQL functions and decision-making triggers, legacy concepts kept alive, oversized frontend components, append-only docs).

**Goal:** the app behaves exactly the same afterwards, but every rule lives in one place, every file has one job, and the docs describe the current truth. No new features during the week.

## Ground rules

1. **Behaviour-neutral.** Every step is checked against a frozen baseline (Day 0). A behaviour change found on the way is noted and done as its own commit after the week.
2. **Small, releasable steps.** Commit after each step with the checks green; no big-bang branch.
3. **Delete before you move.** Legacy concepts go first, so nothing is refactored only to be thrown away.
4. **The server decides, the browser shows** — made true everywhere, not mostly.
5. Work on a dedicated branch, merged step by step.

## Day 0 — freeze a baseline (½ day)

- Tag the starting commit; record `npm run check`, `db:test`, `scripts/test-api.mjs` and the full e2e results.
- **Golden weeks:** 2–3 real production weeks exported with the replay tool (`scripts/replay/README.md`), the showcase department (`docs/SHOWCASE_SCENARIOS.md`) and one QA week. Record each solve result and every request's outcome.
- After every step: re-solve each golden week and diff. Any unexplained difference fails the step.

## Step 1 — remove legacy concepts (day 1)

Pattern per concept: **stop reading → stop writing → drop** (with a tested `supabase/rollback/<ts>_down.sql`). The first two ship in one release, the drop in the next, so a rollback never needs missing data.

Candidates (verify that nothing still reads each one first):

- `trip_shape`, `one_way_from`, `one_way_car_mode`, `leg_car_mode`, `needs_car_at_destination` → `trip_type` everywhere; `submit_request` stops accepting the old-client fields after one release.
- Relocation and overnight machinery: `day_end_time`, the overnight acknowledgement, automatic relocation rides. **Careful:** a Sadran car move also sets `auto_relocation = true` (`pin_reason = 'CAR_MOVE'`) — give car moves their own explicit marker first.
- `department_settings.proposals_offline` and every other column DATA_MODEL marks "deprecated / unread".
- Code paths, tests and `knownDivergence` cases that only served the removed concepts.

## Step 2 — one placement engine (days 2–4, the core)

**Target: TS decides, SQL guarantees.** `src/solver` is the only code that chooses a car, a time, a pairing or a merge. SQL keeps the **invariants** it can check without deciding: the per-car overlap exclusion constraint, the car chain, seats, luggage, permissions, versions.

Shape:

- One server-side placement entry point: an edge function using the bundled solver. It loads the input from the database (never from the browser), decides, and calls one apply RPC that checks the invariants and writes.
- The board, `submit_request` placement, freed slots, trip-type changes and the merge preview all go through it.
- The browser solve becomes a preview: the board may still run it for instant feedback, but what is written always comes from the server.

Order, one decision path at a time:

1. Freed-slot matching — already an edge function with the solver; it is the template.
2. Auto-approve / `place_request_on_car`.
3. One-way pairing and chain healing (`pair_one_way_legs`, `try_widen_one_way_leg`, `connect_drop_off_legs`).
4. Merge check / preview (`_merge_check`, `merge_preview`, `src/lib/rideRoute.ts`).

For each path: when the golden weeks match, delete the SQL decision code and the TS mirror; the parity fixtures become plain solver tests.

Watch out for:

- Placement leaves the `submit_request` transaction: the request is stored first and placed right after, so the form waits for the placement result.
- Edge-function cold starts on the Free plan — measure the first call before committing to this shape.

Realistic scope: paths 1–2 fit in the week; 3–4 may spill over. Each path stands on its own.

## Step 3 — SQL structure (day 5)

- **One readable source per function:** `supabase/sql/<function>.sql` holds the current definition, and a script generates the migration from it, so reviews show a real diff instead of a 900-line copy. **Owner decision needed:** this changes hard rule 8's workflow.
- **Split the large functions into named steps:** `submit_request` (validate → store → stops/children → place → notify → respond), `apply_proposal`, `publish_siddur`, `create_proposal`.
- **Triggers that make decisions become explicit calls.** Triggers stay only for bookkeeping (version, audit, `updated_at`, change counters) and invariant guards. Anything that changes *other* rows (withdrawing proposals, releasing joins, syncing coverage) moves into the RPC that causes it.

## Step 4 — frontend components (day 6)

Guidelines: one component per section or action; logic in pure, tested helpers; state in one reducer/hook per concern; an ESLint `max-lines` warning at about 400 lines per file so files don't grow back.

| File | Split into |
|---|---|
| `RequestForm.tsx` (≈1,800 lines) | one component per section (where/when/who/trip type/stops/plan B/window) + one submit-flow hook owning every dialog (overlaps, release, refusal, on-behalf) |
| `useBoardDnd.ts` (≈1,050) | one handler per drop action (move, merge, shift, swap, reservation) |
| `useBoardData.ts` (≈1,050) | queries separated from derived views (overlays, drafts, warnings) |
| `WeekGrid.tsx` (≈1,700) | layout / ride block / interaction layer |
| `BoardScreen.tsx` (≈900) | header / grid / side panels |

Each area's e2e specs must pass unchanged — they are the contract.

## Step 5 — docs compaction (day 7)

- `REQUIREMENTS.md` describes the current truth: superseded items are rewritten in place, their history moves to `docs/HISTORY.md`.
- `CLAUDE.md` keeps rules, commands, the folder map and where-to-look (about 300 lines); the dated "Owner batch …" sections move to `HISTORY.md`.
- Dated plans and audits (`*_PLAN_2026-*`, `E2E_AUDIT_*`, `HARDENING_*`, `PILOT_FIX_ROUND_*`) move to `docs/archive/`.
- `DATA_MODEL.md` keeps meaning and decisions, not function bodies or lists the schema dump already holds.
- Finish with `/review-consistency`.

## Done when

- The golden weeks give the same outcome for every request, or each difference is listed and approved by the owner.
- `check`, `db:test`, the API tests and the full e2e suite pass.
- No placement rule exists in both SQL and TS (or the remaining ones are listed with a date).
- No legacy column is read anywhere; columns not yet dropped are scheduled for the next release.
- No file is over the size budget without a written reason.
- `CLAUDE.md` is about 300 lines and REQUIREMENTS has no "superseded" notes.

**If the week runs short, priority:** Step 1 (legacy) → Step 2 (engine, paths 1–2) → Step 5 (docs) → Step 4 (frontend) → Step 3 (SQL structure).
