---
name: change-weekly-cycle-defaults
description: Change department weekly-cycle defaults or the scheduler (request window open/close dow+time, publish target, turnaround buffer, detour limit, proposal expiry, reminder timing, pg_cron jobs). Use when asked to "close requests on Tuesday instead of Wednesday", "change the default cycle", "send the reminder earlier", "change the cron", "change the turnaround buffer default", "change when the week opens".
---

# Change weekly-cycle defaults / scheduler

REQ §4: timing is **configurable per department**; code holds only defaults and the tick plumbing. Decide which of three things you are changing:

| Change | Where |
|---|---|
| One department's timing | No code — Admin → Departments → Settings (writes `department_settings`, or `weeks.settings_overrides` for one week). |
| The **default** for new departments | `department_settings` column defaults (migration) + seed + docs. |
| How/when the scheduler runs (cadence, new transition, new reminder) | A tick sub-function (`create or replace` in a new migration; the original is `20260907091600_cron.sql`) + template + docs. |

## Design (DATA_MODEL §3.1, §3.5, §6 step 17; ARCHITECTURE §10, §11)
- `department_settings`: `open_dow/open_time` (default Sun 00:00), `close_dow/close_time` (Wed 12:00), `closing_reminder_hours int[]` ('{24,2}'), `publish_dow/publish_time` (Wed 20:00), `turnaround_minutes int` (30 — was 15 in v0.2), `day_end_time time` ('23:59' — every shared car must be home by this local time unless the Sadran acknowledges an overnight stay), `chauffeur_dwell_minutes int` (10), `detour_limit_minutes` (20), `detour_limit_km` (15), `proposal_expiry_mode` ('at_publish' | 'fixed_hours'), `proposal_expiry_hours` (24), `auto_apply_accepted_proposals` (true), `board_start_time` ('05:00'), `weeks_open_ahead` (1), `overrides jsonb`. The late penalty is a policy param (`submissionTime.latePenalty`, SOLVER §4.3), not a setting. **Removed in v0.3** (owner answers 2026-09-06, DATA_MODEL §3.1): `fairness_lookback_weeks` — the lookback is the `lookbackWeeks` param of the fairness *policy rule* (default 3, REQ §13.18), not a department setting; `members_may_add_temp_cars` — any member may register a temporary car, an admin can revoke it (REQ §13.53); there is no department-level "rides may end after Saturday" setting — it is per-ride (`rides.overflow_allowed`, REQ §13.62).
- `weeks`: `(department_id, week_start)`, `phase` (`open, solving, published, live, archived`), `open_at`, `close_at`, `publish_at` computed from settings at creation; Sadran may override per week.
- **Exactly one** pg_cron entry: `cron.schedule('app_tick', '*/15 * * * *', $$select app.tick()$$)`. `app.tick(p_now)` converts to Asia/Jerusalem and calls in order `advance_week_phases()`, `send_due_reminders()`, `expire_proposals()`, `drain_push_outbox()`, `housekeeping()` (which also runs `expire_freed_offers()`, `materialize_templates()` and the prunes on internal cadences). Never add a second `cron.schedule`; pg_cron expressions are UTC — never encode Jerusalem wall-clock in them.
- Reminders are notification events (`window_open`, `window_closing`, …, UX_FLOWS §6.1) sent via `enqueue_notification()` with dedupe keys so a doubled tick is harmless.

## Steps

### A. Change a default
- [ ] Migration `YYYYMMDDHHMMSS_change_default_<setting>.sql`: `alter table public.department_settings alter column <col> set default <v>;` If existing departments should follow: explicit `update … where <col> = <old default>;` and say so in the header.
- [ ] `supabase/seed.sql`: seeded `department_settings` rows.
- [ ] `src/features/admin/settings/schema.ts` (department settings form) defaults/limits and `he.admin.settings.<field>` labels if the range changed.
- [ ] Docs: `docs/REQUIREMENTS.md` §4 "Default timing" (and §13.10 / §13.11 for buffer/detour); `docs/DATA_MODEL.md` `department_settings`.

### B. Change the scheduler
- [ ] Edit the relevant tick sub-function (`advance_week_phases()`, `send_due_reminders()`, `expire_proposals()`, `drain_push_outbox()`, `housekeeping()`) with `create or replace function` in a **new** migration. Keep it idempotent: decide from `weeks` state and `*_notified_at` / dedupe keys, never from "time since last run". Every sub-function takes `p_now timestamptz` from `app.tick(p_now default now())` for tests.
- [ ] Cadence of the single entry (rare): `select cron.unschedule('app_tick'); select cron.schedule('app_tick', '<expr>', $$select app.tick()$$);` — still exactly one row in `cron.job`.
- [ ] New reminder or transition → `/add-notification-event` for the event + template; extra offsets (e.g. closing reminders) live in `department_settings.closing_reminder_hours` or a new column — document it in DATA_MODEL.
- [ ] New phase → `week_phase` value (own migration), `src/lib/enums.ts` `WEEK_PHASES`, `he.enums.weekPhase` / UX_FLOWS §7.4 + §10 `phase.*`, RLS/RPC checks that read `weeks.phase`, REQ §4 and the state diagram in ARCHITECTURE §5.1.

### C. i18n
- [ ] Reminder copy is a DB template (see `/add-notification-event`); make it data-driven (`{closes_at}`) rather than hard-coding "tomorrow at noon".
- [ ] Admin settings labels: `he.admin.settings.*`.

### D. Tests
- [ ] SQL test for the tick: given settings and a fixed `p_now`, verify opening the right `week_start`, closing at the right instant, reminders exactly once, and a DST week (late March / late October) resolves to the correct wall-clock. Run twice → no duplicate rows.
- [ ] `src/lib/week.test.ts` if TS week math changed.

### E. Docs
- [ ] `docs/REQUIREMENTS.md` §4; `docs/ARCHITECTURE.md` §10 job table; `docs/DATA_MODEL.md` `department_settings`, `weeks`, §6 cron row; `docs/UX_FLOWS.md` §5.10 Settings (and §6.1 notification copy if reminder text changed).

## Final verification
- [ ] `npm run db:reset` passes; `select jobname, schedule from cron.job;` returns exactly one row (`app_tick`, `*/15 * * * *`) as in ARCHITECTURE §10.
- [ ] `npm run lint && npm run typecheck && npm run test` pass.
- [ ] Manual: `select app.tick('2026-10-25 09:00+02'::timestamptz);` on a DST-change week gives the expected phases/reminders.
- [ ] REQ §4 default column == SQL column defaults == seed values.
