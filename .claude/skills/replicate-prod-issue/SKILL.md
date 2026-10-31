---
name: replicate-prod-issue
description: Reproduce a production problem on a local debug copy of production (`npm run debug`), find the root cause, rate the fix risk (trivial vs several blast zones), then either propose the fix (trivial) or write a report. Use when the owner reports something that went wrong in production — "X got an error when…", "this ride/week looks wrong in prod", "reproduce the prod issue", "why did this happen to Y yesterday", "/replicate-prod-issue". Never writes to production.
---

# Replicate a production issue

Turn a production complaint into: a reproduction on a copy of production's data, a root cause, a fix-risk
rating, and either a proposed fix or a report. Tooling: `scripts/debug/README.md` (`npm run debug`).

**Hard limits.** Production is read-only: `npm run debug -- pull` and `npx supabase db query --linked "<select>"`
(SELECT only) are the only things that touch it. Never repair production data yourself — write the repair SQL
into the report for the owner. Write only to the debug stack (`carshare-debug`, container
`supabase_db_carshare-debug`): never the owner's stack (54321), never `npm run db:reset`. Do not commit
unless the owner asks. Member names and rides are personal data: reports go in `.debug/reports/` (gitignored),
the chat summary names only the people the owner already named.

## Step 1 — Pin the incident down

Collect, from the owner's message (ask **one** multiple-choice question only for what is missing and needed):
- **Who** (member / Sadran name), **what action** (screen + button, or "the cron", "a notification"),
  **when** (day + approximate time — Asia/Jerusalem), **which week/day**, the **error text** or the wrong
  outcome and what they expected.
- Decide the weeks to load: the incident's week; add `--with-previous` when car locations, fairness or a
  week boundary may matter; `--all` only for cross-week history.

## Step 2 — Get the data

- [ ] `ls .debug/dumps/` — reuse the newest dump only if it was pulled **after** the incident (the folder
      name is the pull time, Asia/Jerusalem); otherwise `npm run debug -- pull`.
- [ ] `npm run debug -- load --week <YYYY-MM-DD> [--with-previous]` (prints what it cleared; the stack is at
      **production's** migration level after this).
- [ ] Code parity: `git tag -l 'v*' --sort=-creatordate | head -3` gives the production release; check
      `git log --oneline <tag>..HEAD -- <paths you suspect>`. If the checkout differs there, reproduce
      against `git worktree add .debug/release <tag>` (and run the app from it), or note the difference.

## Step 3 — Find the evidence (debug database)

`docker exec -i supabase_db_carshare-debug psql -U postgres -At` and, as needed:

```sql
-- the person
select id, full_name, display_name, email from profiles where full_name ilike '%<name>%' or display_name ilike '%<name>%';
-- browser errors around the time (REQ §13.108): message, page, app version, stack
select created_at at time zone 'Asia/Jerusalem', profile_id, message, url, app_version, left(stack, 400)
from client_errors where created_at between '<from>' and '<to>' order by created_at;
-- what changed and through which RPC (audit_log.reason is the RPC / trigger name)
select at at time zone 'Asia/Jerusalem', actor_id, table_name, row_id, action, reason, changed_columns
from audit_log where week_start = '<week>' and (actor_id = '<id>' or subject_profile_id = '<id>')
  and at between '<from>' and '<to>' order by at;
-- the notices they got
select created_at at time zone 'Asia/Jerusalem', event, title_he, body_he, data from notifications where recipient_id = '<id>' order by created_at desc limit 20;
```

Then read the rows involved (`requests` with `REQUEST_COLUMNS`-style column lists, `rides`, `ride_requests`,
`proposals`, …) and `npm run health -- --container supabase_db_carshare-debug` for data invariants.
The dump is taken **after** the incident: a row's earlier state is in `audit_log.before`. If the bug needs
the earlier state, restore the touched rows from `before` inside the debug database (replica mode) and
say so in the report.

## Step 4 — Attempt the failed action

Use the lowest layer that reproduces it; stop at the first that does.

1. **SQL as the person** (most RPC failures):
   ```sql
   begin;
   set local role authenticated;
   select set_config('request.jwt.claims', '{"sub":"<profile id>","role":"authenticated"}', true);
   -- board actions also: select set_config('request.headers', '{"x-app-surface":"board"}', true);
   select public.<rpc>(<the same arguments the app sends — read them from src/features/*/api.ts>);
   rollback;
   ```
2. **API** — a short `node` script with `@supabase/supabase-js` against `http://127.0.0.1:60731`, signed
   in with `signInWithPassword({ email: <from npm run debug -- logins>, password: 'debug-local-1234' })`
   (PostgREST behaviour, column grants, RLS on reads).
3. **UI** — `npm run debug -- app` (background), `npm run debug -- login "<name>"`, then a Playwright
   script (`chromium.launch()`, `page.goto(<link>)`, the same clicks, `page.on('pageerror')`,
   screenshots) — for rendering, client logic and toasts. Put throwaway scripts in `.debug/`.

Caveats to state when they matter: `now()` is the real clock (an incident on a day that has passed may be
refused for being in the past — shift the rows' dates, or reason about it); pg_cron is paused (cron-driven
bugs: call the function by hand, e.g. `select app.tick()`); edge functions do not run (their effects are
not reproduced — read the function code instead).

**Not reproduced?** Say exactly what was tried and what differs (data state after the incident, code
version, time, browser), then continue with the most likely cause from the evidence, marked as unconfirmed.

## Step 5 — Root cause

Write the chain, each link with a file:line or a SQL function (read current definitions in
`supabase/schema-current.sql`, not old migrations):
symptom → failing statement / wrong branch → why the code does that → which requirement it breaks
(`docs/REQUIREMENTS.md` §, or "undocumented") → why no test caught it (`npm run impact -- --files <files>`
lists the suites that cover the area).

## Step 6 — Rate the fix risk

| Rating | All of these hold |
|---|---|
| **Trivial** | one function / component; no schema, enum, notification or RLS change; no rule that has twins (SQL ⇄ solver ⇄ board, e.g. merge validity, pairing, seat fit); `npm run impact` hits one area; no production data to repair |
| **Moderate** | one area but a migration, a twin rule, or a small production data repair is involved |
| **Complex** | several areas, or the solver + SQL + board together, or notification copy/behaviour, or a requirement question for the owner, or production data that needs a careful repair |

## Step 7 — Deliver

- **Trivial:** propose the fix as a diff. If it is SQL, write the migration and verify it on the copy:
  `npm run debug -- migrate`, re-run the Step 4 reproduction, show it now passes. Then hand over to
  `/bugfixer` steps 4–6 for the regression test and `npm run check` — only when the owner says to fix it.
- **Moderate / Complex:** do not change code. Write the report.

Report — `.debug/reports/<YYYY-MM-DD>-<short-slug>.md`, and a short version in chat:

```
# <one-line problem>
Incident: <who, what, when (Asia/Jerusalem), week/day>  ·  Dump: <folder>  ·  Release: <tag>
Reproduced: yes (SQL|API|UI) / no — <what was tried>
Root cause: <the chain from step 5>
Fix risk: Trivial | Moderate | Complex — <why, per the table>
Proposed fix: <diff or plan; areas and tests it needs>
Production data: <rows affected now; repair SQL for the owner, or "none">
Open questions for the owner: <multiple-choice friendly>
```

Add the finding to `docs/TODO.md` (as the owner's other production bugs, e.g. "O31-1") only when the owner
asks.
