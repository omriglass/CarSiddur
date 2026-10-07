---
name: health-check
description: Run the read-only database health check (scripts/health-check.mjs, `npm run health`) against the local Docker database or the hosted Supabase project and interpret the result — overlapping rides on a car, assigned requests with no ride, confirmed rides with no driver, seat/maintenance/retired-car violations, car chain breaks, stuck proposals, stuck push outbox, week phases lagging the clock, client errors. Use when asked to "check the data", "is production healthy", "run the health check", "find broken data", before/after a publish or release during the pilot, or when a member reports a ride that looks wrong. Reports and investigates; never auto-fixes production data.
---

# Database health check

`scripts/health-check.mjs` runs invariant queries in one `begin read only; … rollback;` transaction (each check in its own savepoint, so a failing query never hides the others) and prints one line per check: level (`ERROR` / `WARN` / `INFO` / `ok`), row count, and up to 5 sample ids with a short description. It writes nothing, anywhere. Never edit it into a fixer: this skill **reports and investigates, it never repairs production data**.

## Run it

Local stack (Docker; needs `npm run db:start`):

```bash
npm run health                                   # container = SUPABASE_DB_CONTAINER, else supabase_db_<project_id> from supabase/config.toml
npm run health -- --container supabase_db_carshare-origins-test
npm run health -- --dept <department-uuid> --from 2026-10-04 --include-archived
```

Hosted project (owner-gated, read-only, needs a local `psql`: `brew install libpq` and put `/opt/homebrew/opt/libpq/bin` on PATH):

```bash
HEALTH_DB_URL='postgresql://postgres.<ref>:<password>@<pooler-host>:6543/postgres' npm run health -- --yes-remote
# or: npm run health -- --db-url '<url>' --yes-remote
```

Rules: use the **owner's** connection string (Supabase dashboard -> Connect -> pooler URI, the DB password is in the owner's hands; never ask for it in chat, never paste or log it, never commit it). Without `--yes-remote` the script refuses. The URL is split into `PG*` env vars so the password is not in the process list; only the host is ever printed. Run the hosted check only when the owner asked for it. Against the owner's local container (`supabase_db_carshare-nevo`) it is safe because it is read-only, but never reset/fake/e2e that stack.

Scope: weeks with `week_start >= --from` (default 14 days ago), non-archived unless `--include-archived`, optionally one department. The outbox, client-error and notification checks are global (last 1h / 24h).

Exit code: `0` no `ERROR` rows; `1` at least one `ERROR` check has rows (or bad arguments / refused remote); `2` a check could not run or the database was unreachable (see the "database messages" block — on an older hosted schema a check may fail on a missing column; that is drift, report it).

## What each check means and what to do

Always: copy the sample id, look the row up (read-only `select` or the board/siddur), find *why* before touching anything. Fixing data goes through the app's own RPCs by a Sadran/admin (or a reviewed migration), never ad-hoc SQL on production. If a check fires repeatedly with the same cause, that is a bug: use `/bugfixer` (reproduce locally, regression test).

| Check | Level | Meaning | What to do |
|---|---|---|---|
| `ride_overlap` | ERROR | Two live rides overlap on one car although the `rides_no_overlap_per_car` exclusion constraint forbids it (constraint dropped/deferred, or a swap that never settled). | Stop publishing for that dept. Find both rides on the board; the Sadran cancels/moves one. Then find which code path bypassed the constraint (`day_car_swap`, restores, manual SQL). |
| `request_assigned_no_ride` | ERROR | Request is `assigned`/`merged` but no non-cancelled ride serves it (member sees "placed", nothing exists). | Look at `ride_requests` for the request and the rides' cancel reasons; usually a cancel/withdraw path that did not reset the request. Sadran re-solves or places it; report the path as a bug. |
| `ride_confirmed_no_driver` | ERROR | A `confirmed` ride with no driver (or `needs_driver` set): should be `flagged` / `NEEDS_DRIVER`. Reservations ("שמירת זמן", no served request) without driver are fine and excluded. | Check `rides.status/flag_reason/driver_id`; Sadran assigns a driver (`set_ride_driver`) or the ride is re-flagged by the next edit. Bug if a code path confirms it. |
| `ride_on_retired_car` | ERROR | Upcoming ride on a retired car. | Sadran moves the ride to another car (board) before the day; ask the admin why the car was retired with rides pending. |
| `ride_seat_config` | ERROR | A ride leg needs more adults/child seats/boosters than the car's `car_seat_configs` allow (same maths as `assert_ride_seats_fit`). | Check the car's seat configuration and the ride's requests (a merged guest added late?). Sadran moves or splits a request. |
| `ride_luggage_capacity` | ERROR | More large-luggage requests than the car's `large_trunk` capacity. | Move the luggage request to a large-trunk car. |
| `ride_on_maintenance_car` / `ride_in_maintenance_block` | WARN | Upcoming ride on a car in `maintenance`, or overlapping a maintenance block. Admins may legitimately override, so this is a warning. | Ask the Sadran/admin whether it is intentional; if not, move the ride. |
| `request_leg_not_covered` | WARN | `assigned`/`merged` request with a live ride but one leg (out/return) uncovered: blocks publication (`incompleteAssignments`). | Open the request on the board; place the missing leg or fix the ride link. |
| `ride_needs_driver_published` | WARN | A published-day ride still needs a driver. | Tell the Sadran; members are waiting for a driver. |
| `ride_turnaround_overlap` | WARN | A ride starts inside the previous ride's turnaround buffer (same-series legs exempt). Can be an intentional manual shortening or a changed turnaround setting. | Confirm with the Sadran; otherwise move the later ride. |
| `car_chain_flagged` / `car_chain_unflagged` | WARN | The car is not where the ride starts (`flag_car_chain_breaks` rule). "Unflagged" = same rule computed here but nothing flagged it yet (normal for drafts until the next edit/publish). | Board shows it as a chain break; Sadran fixes the order/places or adds a car move. Unflagged rows on published days deserve a look at why the flagging trigger did not run. |
| `car_ends_week_away` | WARN | A shared car's last ride of a published/live week ends away from its base; next week starts there. | Informational for the Sadran; add a car move if the base matters. |
| `proposal_sent_not_expired` | WARN | A `sent` proposal that `expire_proposals()` should have expired (request day passed / day published) and the 15-minute `app.tick()` has not. | Check the cron (`cron.job_run_details`), `app.tick()` errors and that pg_cron is running; a paused hosted project explains everything. |
| `proposal_draft_published_day` | WARN | Draft proposal left on an already-published day (an unsent board edit). | Sadran sends or discards it (`discard_proposal`). |
| `push_outbox_stuck` / `push_outbox_failed_24h` | WARN | Pending push rows older than 1 h, or rows `failed`/`dead` in the last 24 h. Reasons are in `push_outbox.last_error` (not printed: may contain endpoint URLs). | Check the `push-dispatch` edge function logs and VAPID secrets; `dead` rows with 404/410 are expired subscriptions (normal, pruned). A pile of fresh failures means pushes are broken for everyone. |
| `week_phase_lag` | WARN | A week's phase is more than 1 h behind the clock (`open` past `close_at`, `published` after the week ended, …): the 15-minute cron stalled. | Same as stuck proposals: pg_cron / `app.tick()` / paused project. Do not hand-edit `weeks.phase`; fix the scheduler. |
| `client_errors_24h` | INFO | Top client-side error messages of the last 24 h (id column = message). | Triage the top few: `/bugfixer` with the message; `url`/`stack` are in `client_errors`. |
| `notifications_24h` | INFO | Notifications queued in 24 h per event (sanity check that the pipeline is alive; 0 on a busy day is suspicious). | None. |

DB-enforced already (so these almost never fire; they exist to catch a bypass): `ride_overlap` (exclusion constraint), `ride_seat_config` and `ride_luggage_capacity` (deferred triggers), maintenance guard (non-admins only).

## Reporting

Give the owner: the command and target (never the URL), the summary line, every `ERROR`/`WARN` check with its count and one or two sample ids, your read on the cause, and the proposed fix path (who fixes it, via which screen/RPC). Do not paste member names or phone numbers. If `npm run health` is clean, say so with the scope used (weeks, departments).

## Extending

A new check is an entry in `buildChecks()` in `scripts/health-check.mjs`: SQL returning `(id text, detail text, n int)` rows, already ordered, read-only. Read current definitions in `supabase/schema-current.sql` (never old migrations), keep details free of names/phones, add a row to the table above, and run `npx vitest run scripts/health-check.test.mjs`. Verify a new check fires by injecting bad rows inside a transaction on a **disposable** stack and rolling back.
