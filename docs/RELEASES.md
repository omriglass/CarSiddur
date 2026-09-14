# Releases and incidents (newest first)

Release notes and incident log for carsiddur. `docs/FREE_DEPLOYMENT.md` is
the standing procedure (how to deploy); this file is the history of what
actually happened. From the first tagged release onward, entries here should
match `npm run release`'s tag messages (`git tag -l -n99 'v*'`); entries
before tagging existed are dated by commit/deploy day instead.

## 2026-09-14 — Release and rollback tooling; QA impact map; ride-passenger and board polish

Release/rollback machinery added (this change, not yet tagged): `npm run
release` (`scripts/release.mjs`) as the one path from a checked-in `main` to
a pushed release tag — backup, migration push, edge-function deploys, tag —
gated by a required-reviewer approval on GitHub's `production` environment
before Cloudflare ever rebuilds the Worker (owner decisions 2026-09-14
#1–#2); `scripts/check-migrations.mjs` flags a new migration that drops or
renames without a tested `supabase/rollback/<ts>_down.sql` (owner decision
#4, forward-fix only); an in-app version footer on `/profile` (owner
decision #5); `docs/RUNBOOK_ROLLBACK.md` and this file replace the dated
sections that used to live in `FREE_DEPLOYMENT.md`.

Also shipped today:

- **QA impact mapping**: `docs/TEST_MAP.md` + `test-map.json` + `npm run
  impact` — diffs changed files against ~17 impact areas and prints the
  exact Vitest/SQL/Playwright commands and a QA checklist; wired into CI as
  an informational, gap-catching step. Playwright specs tagged by area;
  `/bugfixer` skill added.
- **E2E audit**: all 27 Playwright specs reviewed against REQ §13.77–85
  (`docs/E2E_AUDIT_2026-09-14.md`); `board-coordination`/`one-way-consent`
  fixed to compose a Sadran merge proposal before publishing
  (`proposal_day_public` root cause); flaky/time-dependent specs recorded in
  `docs/TODO.md`; CI's e2e job now writes real Edge Function secrets (VAPID
  pair + `CRON_SECRET`) and uses the GitHub reporter.
- **Ride passengers and board**: one passenger list per ride; live policy
  score shown on the board chip; policy-score statistics fix; sharing tiles
  split; board grid hides private cars on days with no ride; ride labels
  slide with the grid's scroll.
- **Requests**: new-request button reads "בקשה חדשה" while open (still
  targets next week, greys out while closed, becomes the waiting-list action
  once published); quick-request sheet has a sticky submit bar (Safari fix)
  and hides weekly-only fields; multi-day ("series") regression fix.
- **Backlog batch**: pack/spread policy option, adding passengers to a ride,
  a WhatsApp link on joinable rides, drop-overlap check, edge-function error
  codes; per-week close time; statistics indicators; reservation people;
  joinable rides; car mileage balance.
- **Tooling**: CI moved to Node 24 (supabase-js 2.115 needs native
  WebSocket); refactor batch — `src/lib/enums.ts`, board drop-validity
  extraction, SQL-only auto-approve, shared `bearerToken`; launch-readiness
  batch — error screen, security headers, `scripts/db-export.mjs`,
  Cloudflare docs, skill/agent fixes.

## 2026-09-08 — Reliability fixes

Four migrations: admin member RPCs, a status-event enum, production
notification templates/triggers, and week recovery. The frontend from this
release calls the new admin and week RPCs, so the migrations had to land
first (`npx supabase db push`) — no demo seed data imported. Notification
templates now arrive through migrations and preserve any existing hand
customizations.

Missing current/upcoming weeks are now recovered automatically — when an
authorized member or admin loads their department, and by the regular cron
tick — without disturbing existing closed or published weeks. A recovered
week whose deadline has already passed opens directly into `solving`;
members can still submit late requests. The `app_tick` cron job must stay
enabled for scheduled openings/reminders while nobody is actively using the
app.

Verified on the hosted app after redeploy: fresh direct URLs load, an admin
profile edit, ordinary-member roster assignment, signup-approval
notifications, and requests in both the current and an upcoming week.

## 2026-09-07 — Department isolation, display names, route calculation

Department removal, per-member display names, department-isolated catalogs
(destinations/ride types no longer shared across departments), and
Google-calculated destination routes. Migrations first
(`npx supabase db push`) — existing shared catalogs were copied into
independent per-department catalogs — then the `destination-route` function
(`npx supabase functions deploy destination-route`; needs a
`GOOGLE_MAPS_API_KEY` Edge Function secret with the Routes API enabled, or
manual destination editing still works and the calculation button explains
the missing setup), then the frontend.

Local validation before this release: full migration/seed replay in a
disposable database, regenerated Supabase types, all 16 SQL suites (as they
existed then), lint, typecheck, 470 unit tests, and a production/PWA build;
18 relevant Playwright scenarios covering nickname reset, membership
removal, catalog isolation, reviewed route saving, view-only switching,
selected-department temporary cars, requests and weekly permissions.
Checked against provider documentation on 2026-09-07.

### Incident: `gen_random_bytes(integer) does not exist` during migration 0915

Some hosted projects use a migration connection search path that excludes
the `extensions` schema, so migration `…0915`'s call to `generate_token()`
failed before the pgcrypto wrappers in migration `…0918` had been installed.

Fix applied: open
`supabase/migrations/20260907091800_pgcrypto_public_wrappers.sql` locally,
run its contents by hand in the target project's SQL Editor as the default
`postgres` role (creates/replaces only the existing crypto wrappers — no
table or data reset), then re-run `npx supabase db push` — already-applied
migrations are skipped and `…0915` retries; `…0918` is safe to run again
because it uses `create or replace function` and repeatable grants. Do not
mark `…0915` as applied by hand, and do not reset the cloud database to work
around this.
