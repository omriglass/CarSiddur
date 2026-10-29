---
name: qa-concurrent
description: Run the concurrency QA cycle — two QA Sadran agents (both Sonnet) plan the same mock week at the same time on a disposable stack, on overlapping days and through both the CLI and the UI, while the lead fires synchronized "race" pairs (scripts/qa/race.mjs) and checks the data invariants after each phase; a QA user agent (Sonnet) then does a pass-only check of what members see (no live-week edits). Use when asked to "QA with two Sadrans", "test concurrent editing", "check that two coordinators can work together", "concurrency QA", or "/qa-concurrent".
---

# QA — two Sadrans at once

Spec and tooling: `docs/QA_SIMULATION.md` (§0 ground rules, §2 command reference, "Two Sadrans at once"). This is the run order for a **concurrency** run; `/qa-week` is the single-Sadran run. **Never the owner's stack** (port 54321): everything below runs on a disposable stack.

What it is for: things a single-session test cannot see — two boards open on one week (live sync, the patch-then-reload of a changed ride, stale versions), two writes to the same rows at the same instant (row/advisory locks, deadlocks, unique indexes, `stale_input`), and that the week stays consistent (no double booking, no request on two rides, no lost change) whatever the interleaving.

## Step 1 — Ask the owner (one message)
1. Emphasis: which recent changes to aim at (default: the current branch's diff against `main` — read it and list the user-visible changes).
2. Seed (reuse one to compare runs, or new).
3. UI share: which day(s) each Sadran works through the UI (default: the shared day for both).

## Step 2 — Stack, week, second Sadran
1. Disposable stack (CLAUDE.md "Running the SQL suites without touching the owner's local data"): copy `supabase/` to the scratchpad, own `project_id`, ports that no running stack uses (`docker ps`), `npx supabase start --workdir <dir>`. Put `CRON_SECRET=local-dev-cron-secret-change-me` in `<dir>/supabase/functions/.env` **before** `start` (a `docker restart` of the edge runtime does not reload it), then the freed-car settings of `docs/QA_SIMULATION.md` ("Freed-slot offers on the disposable stack") with the stack's Kong name.
2. `QA_API_URL=<api> npm run qa:week -- --seed <n> --out <scratchpad>/qa-run --api <api>`.
3. **Second Sadran** in the QA department: a `member_invites` row with `role: 'sadran'` for `sadran2@<tag>.qa.local`, then `auth.admin.createUser` with password `qa-member-1234` (service key; the same two calls `createAccounts()` in `scripts/qa/generate-week.mjs` makes). Check both are `approved` / `sadran` in `department_members`.
4. A UI port of your own (`QA_UI_PORT`, not 8092 if another session may own it).
5. Show the owner the summary (`<out>/summary.md`, one screen) and the planned split; wait for a go.

## Step 3 — Opening race (lead)
Both Sadrans press auto-fill at the same instant: `QA_OUT=<out> node scripts/qa/race.mjs --a "autofill" --b "autofill"`. Expected: one applies, the other is refused (`stale_input`) or finds nothing left; never two rides for one request. Then the invariants (Step 6).

## Step 4 — Agents (all `subagent_type: general-purpose`, `model: sonnet`, background)
Split the week so the Sadrans **share at least one busy day** and each also owns days alone. Brief each Sadran with: the `qa:sadran` reference (`docs/QA_SIMULATION.md` §2, with `--email/--password` for Sadran B), the UI helper (`scripts/qa/uiSession.mjs`, `QA_UI_PORT`), the mailbox path, its days, the emphasis list, and these rules:
- Work like a real coordinator on the same week as the other Sadran, **without coordinating**: on the shared day touch the same rides and requests the other one is likely to touch (the most contested cars and times).
- Before each write on the shared day re-read the day (`qa:sadran day`); report every refusal with its exact text and judge whether it was right (a stale version / "someone changed this" after the other's change is correct; a silent overwrite, a lost change or a request on two rides is a bug).
- **UI live-sync checks** (at least three): keep the board open in a Playwright page while the *other* Sadran's change lands (the lead can trigger one with `race.mjs` or a CLI command); confirm within ~5 s that the page shows it without a reload, and that a drag on a block the other one just changed is refused, not applied over it.
- Exercise the emphasis list (for example: closing a waiting request and restoring it from the change log, cancelling a ride with a per-person "still needed?" choice, the drop questions on merge / split / move / unplace, the change log's requested-vs-got rows).
- Never read `personas.json`; ask members only through proposals and the mailbox. Time box ~75 minutes. End with findings (§4 format, ≤ 40 lines) plus every refusal seen and whether it was correct.

Brief the **QA user** with `personas.json`, the `qa:member` reference and the mailbox: answer proposals in persona while the Sadrans work (poll the inbox every few minutes); after the lead says the days are published, a **pass-only check** — for ~10 members across the shared day and the others: `my-rides`, `siddur <day>` and `inbox` agree with each other and with what was published; one notice per change, no duplicates (watch closed / restored requests: one "your request was closed" notice, and none left after a restore). **No live-week edits** unless the owner asked for a live phase. Report ≤ 30 lines.

Relay messages between agents only when one is waiting on the other (SendMessage); never pass persona details to a Sadran.

## Step 5 — Lead race rounds (while the agents work, or after)
Run synchronized pairs with `scripts/qa/race.mjs` (both sides load their board, then fire at the same instant). Prefer a **separate department** on the same stack (e.g. the one `npm run qa:regression` leaves behind, with its own second Sadran) so the races do not confuse the agents; use the QA week only for the opening and closing races. Useful pairs (ids are the CLI's 8-character suffixes):
- move vs unassign of one ride; two placements of one request on two cars (`--force` on both so the server decides); two different requests onto one free car slot (expected: one placed, the other refused with the overlap message — never a silent planning conflict, REQ §13.164 a);
- close vs place of one waiting request; `cancel-ride --close` vs merge onto that ride; trip-type change vs place;
- the same proposal sent / discarded / agreed by both; `send-held` by both; `publish --days d` by both (one publishes; the other refused by the fingerprint or finds it published).
Judge each: exactly one outcome applied, the other refused with a sensible message, nothing half-applied.

## Step 6 — Invariants after every phase
- `docker exec -i <db container> psql -q -U postgres -v dept=<id> -v week=<date> -f - < scripts/qa/invariants.sql | grep -v '^STAT'` (CAR_OVERLAP also lists planning-conflict shadows — check `rides.planning_conflict` before calling one a bug).
- `npm run health -- --container <db container> --dept <id>` (read-only).
- Locks and errors: `select … from pg_stat_activity where wait_event_type = 'Lock'` while racing; `client_errors` rows; Postgres log lines with `deadlock detected` / `canceling statement due to statement timeout` (`docker logs <db container> --since 2h | grep -E 'deadlock|timeout'`).

## Step 7 — Report
One dated section in `docs/TODO.md` ("QA concurrency run N"): seed, split, races run and their outcomes, then findings in the usual four categories (Bugs, UI changes, Missing obvious features, Additional features), each with day / request / ride and how to reproduce. Present to the owner and wait — this skill finds, it does not fix.
