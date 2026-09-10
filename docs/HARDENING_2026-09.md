# Production hardening — 2026-09-10 audit

Structural review before go-live, focused on three owner concerns: unintended
privilege ("hacks" through bad permissions), requests/rides going missing or
orphaned, and response times. Findings were verified against the *current*
schema (a `pg_dump` of the local stack, all 137 migrations applied) and, where
marked **reproduced**, executed locally inside a rolled-back transaction.

Each item carries a status. `done` items name the migration or file that fixed
them; the canonical docs (REQUIREMENTS, DATA_MODEL, ARCHITECTURE, UX_FLOWS) were
updated in the same change, this file is the audit trail.

## 1. Permissions

### 1.1 Function grants were default-open — **done** (`20260910099000_revoke_default_function_grants.sql`)

Supabase's default privileges (`pg_default_acl` for role `postgres`) grant
`EXECUTE` on every new function to `anon`, `authenticated` and `service_role`.
Migrations only ever revoked `from public, anon` on a handful of RPCs, so **298
functions were callable by any signed-in member** while the app calls 61, and
about ten of them are internal or cron routines with no authorization check of
their own. The rule "anon has no grants" (DATA_MODEL §4.1) also did not hold for
functions: `dispatch_push_outbox_row`, `set_request_children`,
`assert_ride_seats_fit` were executable by `anon`.

Reproduced with the seeded `member1`:

| Call | Effect |
|---|---|
| `try_auto_approve(own request)` in the **open** week | request became `assigned` with a confirmed, pinned ride — solver and fairness bypassed; works on other members' requests too |
| `enqueue_notification(member2, 'access_approved', …, data.url = attacker URL)` | inbox + push notification delivered with an attacker deep link (phishing through the app's own channel) |
| `housekeeping('2099-01-01')` | deleted every `notifications` row, the whole `audit_log`, every `push_subscriptions` row, scrambled all proposal tokens |

Verified by reading: `resolve_freed_offer(offer, ranked_candidates)` trusts the
caller's candidate list (a member can hand themselves the freed car);
`expire_proposals`, `expire_freed_offers`, `send_due_reminders`,
`drain_push_outbox`, `maybe_apply_accepted_proposal` accept a caller-supplied
clock; `freed_slot_candidates`, `car_care_recipients`, `car_location_at` leak
other members' request/profile ids.

Fix (DATA_MODEL §4.2 "Function grants"):
- `alter default privileges in schema public revoke execute on functions from public, anon, authenticated` — every new function starts with **no** grants and a migration must grant `authenticated` explicitly (`/add-migration` skill updated).
- All non-extension functions in `public`: revoked from `public` and `anon`.
- Internal / cron / helper functions revoked from `authenticated` (explicit list in the migration). Helpers referenced by RLS policies, views, constraints and index expressions keep their grant because they run as the querying role.
- `rls_smoke.sql` asserts: anon can execute no application function; the internal list is not executable by `authenticated`; default ACLs no longer include `anon`/`authenticated`.

### 1.2 Internal functions carry their own guard — **done** (`20260910099100_guard_internal_functions.sql`)

Belt and braces for 1.1: `housekeeping`, `expire_proposals`,
`expire_freed_offers`, `send_due_reminders`, `drain_push_outbox`,
`dispatch_push_outbox_row` each call `assert_not_direct_rpc(name)` first, which
refuses when PostgREST's `request.path` GUC equals `/rpc/<name>` (a direct
top-level call) and the caller is not admin; a nested call from another RPC
(e.g. `publish_siddur` → `expire_proposals`) or from pg_cron sees a different
`request.path` (or none) and is unaffected. `try_auto_approve` now locks the
request `for update` and returns `null` unless the request is `submitted` or
`waitlisted` (it previously had no status check and could resurrect a withdrawn
request).

`app.tick()` runs each of its five steps in its own exception block: a failure in
one step is recorded in `app_settings.tick_last_error` (`{step, message, at}`)
and raised as a warning, and the remaining steps still run. Previously one
raising step silently stalled reminders, proposal expiry and push delivery until
someone noticed (ARCHITECTURE §10).

### 1.3 Car lockbox codes readable across departments — **done** (`20260910099900_car_access_codes.sql`)

`cars_select` is `is_approved()` with no department scope — intentional, because
members may read other departments' published siddurim (REQ §13.52) — but the
row also carried `access_code` / `replacement_code`. Any approved member could
`select access_code from cars` for a department they do not belong to.

Fix: codes moved to `car_access_codes (car_id pk, department_id, access_code,
is_replaced, replacement_code)` — `is_replaced` moves too because the two-code
check constraint depends on it; SELECT `member_of(department_id) ∨ can_manage_operations(department_id)`;
writes `can_manage_operations(department_id)`; `department_id` is copied from the
car by trigger; no `audit_row` (codes must not land in `audit_log`). The
siddur/request cards embed `car_access_codes` (null for other departments, so the
car name renders without a code); the admin car form writes the two rows.

### 1.4 `notification_templates` writable by any permanent Sadran — **done** (`20260910099700_notification_templates_admin_only.sql`)

Policies used `can_manage_operations()` with no department argument, which is
"admin or permanent Sadran of *any* department". The table is global. Now
`is_admin()` for insert/update/delete, as DATA_MODEL §4.3 always said.

### 1.5 `weeks` had direct write policies — **done** (`20260910099300_drop_direct_delete_and_week_writes.sql`)

`weeks_update` (`can_manage_operations(department_id)`) let a Sadran set
`published_days` directly — days became public without `publish_siddur`'s
conflict check, snapshot or notifications. Only `published_version_id` was
trigger-locked. The frontend never wrote `weeks` directly; all writes go through
`open_week`, `set_week_phase`, `publish_siddur`, `reopen_week`,
`ensure_department_weeks`. The `weeks_insert/update/delete` policies were dropped:
`weeks` is RPC-only like `requests` and `rides`.

### 1.6 `car_issues` reporter could self-resolve — **done** (`20260910099800_car_issues_protect_reporter_fields.sql`)

`car_issues_update`'s CHECK dropped the `status = 'open'` condition of its USING;
an existing trigger already locked `status`/`resolved_by`/`resolved_at`/`is_unsafe`
against a plain reporter, but not `category`/`car_id`/`department_id`/`reported_by`,
so a reporter could still reassign their own report to a different car/department
or change its category. The trigger now also locks those four columns. A `before
update` trigger lets a non-admin, non-Sadran reporter change only `description` and
`photo_path`.

### 1.7 `profiles.phone` readable by every approved member — **done** (`20260910100000_profiles_phone_column_grant.sql`)

DATA_MODEL §4.3 already said "`phone` column revoked (use `phone_of`)", but a
table-level `grant select on profiles to authenticated` made the column-level
revoke ineffective. Now the table-level SELECT is replaced by a column list
without `phone`; `select *` on `profiles` fails for members by design. The app
reads phones through `phone_of(uuid)` (own / admin / Sadran / shares a ride) and
the new `profile_phones(uuid[])` (same predicate, set-returning) for the admin
member list and the Sadran contact sheet.

## 2. Missing / orphaned requests and rides

### 2.1 `withdraw_request` left the ride booked — **done** (`20260910099200_withdraw_request_releases_rides.sql`) — **reproduced**

A member withdrawing an `assigned` non-series request flipped it to `withdrawn`
and left the confirmed ride, its driver and the `ride_requests` row in place:
the car stayed booked by nobody. (The UI hides "withdraw" once a ride exists, so
this needed a direct RPC call or a stale screen, but the server invariant was
missing.) Now: draft rides (planning phase) are released via
`release_request_draft_rides()` — REQ §5.2 "any non-final state → withdrawn";
a request on a confirmed/flagged ride raises `request_has_ride` and the member
must `cancel_ride` instead — REQ §5.2 "cancelled (by member after publish, frees
the ride)". The optimistic-lock check now also rejects a null
`expected_version`.

### 2.2 Admins could hard-delete rides and requests from the client — **done** (`20260910099300_…`)

`rides_delete using is_admin()` and `requests_delete using (own draft) or is_admin()`.
`ride_requests` cascades, so a deleted ride left its requests `assigned` with no
ride, and a deleted driver request left a ride with no driver row. Both policies
dropped; the frontend never used them. Rides are cancelled, never deleted
(DATA_MODEL §4.3).

### 2.3 Concurrent cancels created two freed-slot offers — **done** (`20260910099400_lock_cancel_and_move_series.sql`)

`cancel_ride_without_passengers` read the ride without `for update`, had no
already-cancelled guard, and skipped the version check when `expected_version`
was null; `freed_slot_offers` had no uniqueness on `cancelled_ride_id`. Two
near-simultaneous cancels (double tap, or driver + Sadran) produced two live
offers claimable twice. Now: `for update`, `ride_not_found` if already cancelled,
`expected_version` required, and a partial unique index on
`freed_slot_offers (cancelled_ride_id) where status in ('open','pending_approval')`.
`move_series` locks the first ride `for update`.

### 2.4 `apply_solver_result` full mode could strand requests — **done** (`20260910099500_apply_solver_result_reconcile.sql`)

Full mode deletes every non-pinned draft ride, then re-statuses only the requests
present in the payload. A client bug that omitted one left it `assigned` with no
ride. The RPC now remembers which requests lost a draft and, after applying the
payload, resets any of them still `assigned`/`merged` with no covering ride to
`submitted` (`status_reason = 'SOLVER_UNPLACED'`), returning the count as
`unplaced_reset` so the board can surface it.

### 2.5 Companions written in two browser calls — **done** (`20260910099600_set_request_companions_rpc.sql`)

`setRequestCompanions()` did a `delete` then an `insert` on `request_companions`
as two HTTP requests; a failure between them lost the companions. Replaced by the
`set_request_companions(request_id, profile_ids)` RPC (requester or
`can_manage_week`, one transaction), mirroring `set_request_children`. The direct
`request_companions` write policies were dropped.

## 3. Response times

Scale is small (tens of members, a handful of cars), so SQL cost is bounded; the
felt latency is client-side round-trips.

| # | Finding | Status |
|---|---|---|
| 3.1 | Board preview (`BoardScreen.computePreview` → `gatherSolverContext`) refetched 9 endpoints outside the query cache 300 ms after load and after **every** edit, then ran the solver on the main thread — ~25 requests per edit cycle | done — preview input is built from the screen's already-loaded query data (`buildSolverContextFromData`) |
| 3.2 | One 1.5 MB JS chunk, zero lazy routes: members downloaded the board, admin and solver on first open | done — every Sadran/admin/operations page is `React.lazy` behind one `Suspense` per area; main chunk 1,511,970 → 1,318,071 bytes, board 76 kB and ~20 admin pages split out |
| 3.3 | `fetchActivePolicy` two sequential requests (`policies` then `policy_versions`) | done — one FK embed |
| 3.4 | `useIsSadranAnywhere` chained weeks → one `can_manage_week` RPC per week, mounted twice | done — `can_manage_any_open_week(dept)` RPC |
| 3.5 | `fetchMyUpcomingRides` paged loops (up to 3+ sequential calls), repolled every 30 s on Home | done — three fixed calls, no client-side paging (the view `v_board_rides` has no FK embeds) |
| 3.6 | Per-row SECURITY DEFINER calls in `requests`/`rides` SELECT policies (`request_served_by_public_ride`, `is_day_public`) | accepted at current scale; first thing to rewrite as a set-based `exists` if the board ever feels slow |
| 3.7 | `publish_siddur` fans out push rows synchronously (one `push_outbox` insert + pg_net POST per subscription inside the transaction) | accepted at current scale (pg_net queues asynchronously) |

## 4. Production configuration checklist (MAINTENANCE.md)

- `app_settings.push_dispatch_url` and `app_settings.on_ride_cancelled_url` set to the deployed edge-function URLs; otherwise pushes leave only via the 15-minute drain and freed-slot matching never fires.
- `app_secrets.cron_secret` set and equal to the edge functions' `CRON_SECRET`; the functions correctly reject requests when the secret is unset.
- `vercel.json` has no security headers; add `X-Frame-Options`/CSP when convenient (low).
- Edge functions contain inline Hebrew error strings (hard rule 3) — cosmetic, tracked in `docs/TODO.md`.
