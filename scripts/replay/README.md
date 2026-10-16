# Week replay — re-run a production week's solve locally

Rebuilds one department's week from production on a dedicated local stack, re-runs the real
board solve on it, and compares the result with what production's solver did. The yardstick for
solver changes (REQUIREMENTS item 136).

Nothing here connects to production. The owner runs one read-only query in the Supabase SQL
editor and hands over the downloaded file; every script below only writes to the replay stack
(`carshare-replay`, API `http://127.0.0.1:56321`, DB `127.0.0.1:56322`) and refuses any other
database container. Exports and the stack copy live in `.replay/` (gitignored — they hold member
names and rides; never commit them).

## 1. Export (owner, Supabase dashboard)

1. Open `scripts/replay/export-week.sql`, set `dept` and `week` (the Sunday) in `params`.
2. Run it in the SQL editor. It is a single `SELECT` (no writes, no function calls with side
   effects). It leaves out emails, phones, avatars, invites, push subscriptions, notifications,
   car access codes and proposal tokens.
3. Download the result (JSON or CSV) into `.replay/data/`.

It returns one row per table: the department's catalogs, members' names, cars, the policy,
five weeks of requests/rides back (fairness and mileage history) and two ahead, plus the
target week's solver runs and the change history (`audit_log`) of the target week and the
week before it.

## 2. Load (local)

```sh
npm run replay:stack -- start                       # once; later starts only add new migrations
npm run replay:load -- --export .replay/data/<file> # default: --at before-first-run
```

`--at` picks the moment the target week (and the week before it) is rebuilt from the audit log:
`before-first-run` (default — what the first applied solver run saw), `before-last-run`,
`after-first-run` (production's solver output), `now` (as exported, manual edits included) or
an ISO timestamp. Unaudited rows (stops, children, companions, plan B) are loaded as they are now.
Rows land exactly as exported (`session_replication_role = replica`: no triggers, no FK checks);
pg_cron is paused on the replay stack so the week never moves by itself.

Every loaded member gets a local login — `sadran@replay.local` (the week's Sadran), `admin1@…`,
`m1@…` (by name) — password `replay-local-1234`, and a placeholder phone;
`.replay/out/<dept>-<week>/world.json` holds the week's Sadran for the QA CLI and `logins.json`
the full list.

## 3. Re-run the solver and compare

```sh
QA_API_URL=http://127.0.0.1:56321 npm run qa:sadran -- autofill --out .replay/out/<dept>-<week>
npm run replay:compare -- --export .replay/data/<file> [--run first|last|<solver run id>] [--json out.json]
```

Then what the Sadran changed after that run, and every request's score rule by rule:

```sh
npm run replay:compare -- --export .replay/data/<file> --run first --against final --json .replay/out/<dir>/fixes.json
npm run replay:explain -- --out .replay/out/<dir> [--json .replay/out/<dir>/scores.json]
```

`autofill` is the board's own "auto-fill remaining" (gatherSolverContext → solve →
apply_solver_result), signed in as the week's Sadran; `resolve-full` and `autofill --day
YYYY-MM-DD` work the same way. `compare` lines up, per request, production's rides right after
that run (rebuilt from the audit log) with the replay stack's rides now: same, same car at
another time, other car, placed on one side only, unmet on both.

To look at it in the browser: `VITE_SUPABASE_URL=http://127.0.0.1:56321 VITE_APP_URL=http://localhost:8093 npx vite --port 8093 --strictPort`,
then sign in on the dev form as `sadran@replay.local` (the week's Sadran) or `admin1@replay.local`,
password `replay-local-1234` (`logins.json` lists everyone). Localhost only — a phone cannot
reach the replay stack at 127.0.0.1. The periodic review that uses all of this:
`.claude/skills/solver-review/SKILL.md`, results in `docs/SOLVER_REVIEWS.md`.

## Parity notes

- Local `main` must match the release production ran when the week was solved, or the
  difference is code, not data (`git log <release tag>..main`).
- The week before the target is rebuilt too: it is still live while the target is solved, and
  its rides decide where each car starts the week.
- Production's own solve may have been per day (`autofill --day`); the solver runs list printed
  by `replay:load` shows how many runs there were and what each placed.
