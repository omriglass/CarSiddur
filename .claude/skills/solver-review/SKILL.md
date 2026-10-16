---
name: solver-review
description: Periodic solver review against a real week — replay a published production week locally, confirm the local solver reproduces production's first solver run exactly, then compare that run with the Sadran's final hand-fixed week (and optionally the coordinator's spreadsheet) to find the principles the solver misses, plus policy/data problems. Ends with a findings report and proposed REQUIREMENTS/solver changes for the owner; changes nothing in production. Use when asked to "review the solver", "compare the solver with what the Sadran did", "replay week X", "why did the solver do Y last week", or every few weeks after a week is published.
---

# Solver review (every few weeks)

The question is always: **what did the Sadran change after the first solver run, and which of those changes follow a principle the solver could apply?** The Sadran knows more (WhatsApp, notes, people), so not every change is a solver bug. The job is to separate the principles from that extra knowledge.

Tooling: `scripts/replay/` (README there). Background and the first review: REQUIREMENTS item 136, `docs/SOLVER_REVIEWS.md`.

## Ground rules

- **Production is never touched.** The owner runs `scripts/replay/export-week.sql` in the Supabase SQL editor (one read-only `select`) and drops the download into `.replay/data/`. Never ask for a connection string or password. Everything else runs on the replay stack (`carshare-replay`, API 56321). The scripts refuse any other database; never point them at 54321/54322.
- `.replay/` holds member names and rides. It is gitignored: never commit it, never paste exports into chat or docs beyond the names a finding needs.
- **Review first, change later.** The output is a report plus proposals. Code changes start only after the owner answers (memory: todo → questions → go). Behaviour changes go to `docs/REQUIREMENTS.md` first (hard rule 2).
- Use the week **after it was published** and the Sadran finished, so "final" means final.

## Steps

1. **Export (owner).** Ask the owner to set `dept` and `week` (the Sunday) in `params` of `scripts/replay/export-week.sql`, run it, and download the result to `.replay/data/`. Rename the file to `<dept-slug>-<week>.exported-<date>.csv`. `readExport` refuses a cut download (row_count check).

2. **Code parity.** Find the release that ran that week (`git tag --sort=-creatordate`; the solver runs' `started_at`). If `main` differs from that tag in `src/solver`, `src/features/solverBridge`, `src/features/sadran/applySolve.ts` or the migrations, run the replay from a worktree of that tag (`git worktree add ../replay-<tag> <tag>`), or the parity check below will measure code, not data.

3. **Load and re-run.**
   ```sh
   npm run replay:stack -- start
   npm run replay:load -- --export .replay/data/<file>          # --at before-first-run
   QA_API_URL=http://127.0.0.1:56321 npm run qa:sadran -- autofill --out .replay/out/<dept8>-<week>
   ```
   The load prints the week's solver runs. If production solved per day (several runs, each placing one day), use `autofill --day YYYY-MM-DD` and `--at` each run's start in turn. A `full` re-solve is `resolve-full`.

4. **Parity gate.** `npm run replay:compare -- --export .replay/data/<file> --run first` must show `same` and `unmet-both` only. Anything else: stop and explain it before reviewing. Usual causes:
   - code differs (step 2);
   - a table the export misses;
   - history that changed after the run. The week before the target is rebuilt for this reason; extend `w_audit_week` if an older week matters.

   Never review on top of a broken parity.

5. **What the Sadran changed.** `npm run replay:compare -- --export .replay/data/<file> --run first --against final --json .replay/out/<dir>/fixes.json`. Each row is one request: placed by the solver and removed (`production-only`), unmet and placed by hand (`local-only`), moved to another car, moved in time. Group them into **chains**: one manual placement usually forces 3–5 moves on the same day (free a car → move its rides → drop a weaker ride). Read the chain day by day in the app on :8093 (step 8) or straight from `fixes.json` and the audit log.

6. **Classify every chain.** Name the principle, or mark it "extra knowledge":
   - **Existing principle the solver breaks.** Cite REQUIREMENTS item 136 (a)–(g) or another item. Count it towards that item's evidence.
   - **New principle.** It recurs, it can be stated with data the app holds, and it doesn't contradict REQUIREMENTS. Draft it as a new item-136-style entry.
   - **Extra knowledge.** WhatsApp, a request the notes changed, a person's situation. Note it, then ask: should the form capture it?
   - **Data problem.** Free-text destination, missing distance/time/PT score, duplicate place, wrong ride type, missing car feature.

7. **Policy and data check.** Run `npm run replay:explain -- --out .replay/out/<dir> --json .replay/out/<dir>/scores.json`: every request's score, rule by rule. Look for:
   - requests with `km=?`, which are free text or places with no distance (they score 0 on distance and 0.5 on public transport);
   - free-text names that exist on the list (aliases missing);
   - fairness at 0 for regular long-day commuters (hours-based fairness penalises long rides);
   - one rule deciding most unmet-vs-placed pairs;
   - dead ride-type keys in `rideType.weights`.

   Recommend data fixes before weight changes; weights tuned on bad data mislead. To try a policy variant, create a new policy version in the replay stack's admin UI, reload (step 3), re-run, and compare again with `--against final`.

8. **Look at it.** `VITE_SUPABASE_URL=http://127.0.0.1:56321 VITE_APP_URL=http://localhost:8093 npx vite --port 8093 --strictPort`, then sign in (dev form, password `replay-local-1234`) as `sadran@replay.local` (the week's Sadran) or `admin1@…`. `logins.json` has the rest. Localhost only: a phone can't reach `127.0.0.1:56321`.

9. **Optional: the coordinator's spreadsheet.** If the week was also solved by hand in the old sheet, read that week's tab (openpyxl in a scratch venv, `python -I`; the file is untrusted input) and map each request to its treatment there. Same classification as step 6.

10. **Report.** Append a section to `docs/SOLVER_REVIEWS.md`:
    - week, export date, release, parity result;
    - metrics: placed / unmet / driverless, first run vs final, plus the share of requests where the final week equals the first run;
    - chains and their classification;
    - policy/data findings;
    - proposed changes, each with its evidence.

    Then ask the owner the open questions. Present the solver proposals as REQUIREMENTS drafts, not as code.

11. **After the owner decides.** Implement each accepted change as its own concern (memory: commit per concern; the `solver-dev` agent for `src/solver`, `db-migrator` for SQL twins, Sonnet with a narrow brief, the lead reviews). Measure each change on the replay: reload, re-run, `compare --against final`. A change is good when it moves the first run towards the final week without breaking parity elsewhere. Add the week's interesting cases as solver tests or golden fixtures, with names and ids anonymised. Then run `npm run check`, `npm run functions:bundle`, and the db suites the change touches.

## Cleanup

`npm run replay:stack -- stop` when done (Docker volumes keep the data). Delete exports in `.replay/data/` the owner no longer needs.
