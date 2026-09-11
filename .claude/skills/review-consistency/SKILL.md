---
name: review-consistency
description: Review the five docs (REQUIREMENTS, ARCHITECTURE, DATA_MODEL, SOLVER, UX_FLOWS) against each other and against the code (SQL enums, TS enums, ruleRegistry vs validate_policy_rules, i18n keys, notification events, week phases, cron jobs, RLS) and report drift as a checklist. Use when asked to "check docs vs code", "are the docs up to date", "consistency review", "find drift", before a release, or after a batch of migrations.
---

# Review docs/code consistency

Output: a **checklist of drift items**, each with file:line (or §) on both sides and a one-line fix. Report first; fix only if asked. Where code is absent, report "not yet implemented", not drift.

## 0. Re-derive numeric counts from disk

Never copy a count ("N migrations", "N events", "N specs", "N tests") from another doc or from memory — every stale-count drift found in this repo came from one doc quoting a number another doc had already gotten wrong. Recompute each with the exact commands below before writing the report:

- [ ] Migrations: `ls supabase/migrations/*.sql | wc -l`; range: `ls supabase/migrations/*.sql | sort | sed -n '1p;$p'`.
- [ ] Notification events: `grep -h "add value\|create type public.notification_event" supabase/migrations/*.sql` — count every quoted value across the `create type (...)` list plus each `add value` line.
- [ ] SQL test suites: `ls supabase/tests/*.sql | wc -l`, and cross-check against the exact filename array in `scripts/test-db.mjs` (the file actually run by `npm run db:test`) — a file present in `supabase/tests/` but missing from that array never runs.
- [ ] e2e specs: `ls e2e/*.spec.ts | wc -l`.
- [ ] Unit tests: last line of `npm run test` output ("N passed" / "N files") — do not hand-count.
- [ ] Feature folders: `ls src/features`.
- [ ] Any other cited count (rule types, admin screens, edge functions, migrations since a given date) gets its own one-line `ls`/`grep -c` before it goes in the report.

## 1. Gather canonical lists

Docs:
- [ ] REQUIREMENTS: §5.2 request states; §7.3 proposal states; §4 phases + defaults; §5.1 fields; §5.4 legs/car modes (`trip_shape`, `leg_car_mode`, car location); §7.2 rule types; §9 events; §6.1 car statuses; §3 roles; §13 constants (buffer 30, detour 20/15, 15-min grid, fairness lookback 3 weeks, chauffeur dwell 10 min, day end 23:59).
- [ ] DATA_MODEL: §2 enums; §3 tables/columns; §4.2 helpers; §4.3 policy matrix; §6 migration list + seed; retention.
- [ ] SOLVER: §2 types; §3 module list; §3.11 suggestion order; §3.13 reason codes; §4.1 interface; §4.3 rule table; §4.4 default policy; `SolverConfig` defaults.
- [ ] ARCHITECTURE: §4 layout; §5 state machines; §9 events + pipeline names; §10 cron jobs; §13 env vars; §14 commands/ports.
- [ ] UX_FLOWS: §2.1 route table (⇔ `src/app/router.tsx`), §3.4 request-form fields, §6.1 notification copy table, §10 i18n keys (⇔ `he.ts`).

Code (grep, do not read whole files):
- [ ] SQL enums: `grep -n "create type\|add value" supabase/migrations/*.sql` (apply `add value` in file order).
- [ ] Tables/columns: `grep -n "create table\|add column\|drop column\|rename" supabase/migrations/*.sql`; views in `20260907091700_views.sql` and later.
- [ ] RLS: per table `enable row level security`, `force row level security`, `create policy … for <cmd>`; `grep -n "for all\|using (true)" supabase/migrations`.
- [ ] Known rule set in SQL: body of `validate_policy_rules` (latest definition wins).
- [ ] TS: `src/lib/enums.ts` arrays (being introduced, plan E8; until it exists, grep the local `Database['public']['Enums'][…]` aliases the neighbouring code uses instead); `ruleRegistry` keys in `src/solver/rules/index.ts`; files in `src/solver/rules/*.ts`; reason codes in `src/solver/reasons.ts`; `he.enums.*`, `he.notif.*`, `he.admin.policies.rules.*` keys in `src/i18n/he.ts`; `src/features/requests/schema.ts` keys; routes in `src/app/router.tsx`; `package.json` scripts.
- [ ] Emitters: `grep -rn "enqueue_notification(" supabase` (any `insert into notifications`/`push_outbox` outside that function is drift); cron: `grep -rn "cron.schedule" supabase/migrations` (must be exactly one live entry, `app_tick`); edge functions: `ls supabase/functions` ⇔ `push-dispatch, answer-proposal, on-ride-cancelled, destination-route` (there is no `solve` function — the solver runs inside RPCs via the bundled `_shared/solver.js`).

## 2. Cross-checks (one report line each)

Enums — for `request_status`, `proposal_status`, `week_phase`, `ride_status`, `car_status`, `car_type`, `trip_shape`, `leg_car_mode`, `home_week_preference`, `notification_event`, `notification_channel`, `role`, `approval_status`, `freed_offer_status`, `freed_claim_status`:
- [ ] REQUIREMENTS ⇔ DATA_MODEL §2 ⇔ ARCHITECTURE §5/§9 ⇔ SQL ⇔ `enums.ts` ⇔ `he.enums` keys. List every missing/extra value.

Car location / relay model:
- [ ] REQ §5.4, §13.57 ⇔ DATA_MODEL §5 (`rides.origin_id`/`destination_id`, `departments.home_destination_id`, `department_settings.day_end_time`/`chauffeur_dwell_minutes`) ⇔ SOLVER §1.2–1.3, §3.2, §3.6.1 (`CarTimeline`, relay pairing) ⇔ `assert_car_chain()` called at the end of every ride-writing RPC (`apply_solver_result`, `edit_ride`, `apply_proposal`, `try_auto_approve`, `resolve_freed_offer`, `approve_claim`) ⇔ ARCHITECTURE §7 location-chain / day-end rows. Flag any ride-writing RPC that skips the call, and any leftover `one_way` boolean / `leg_direction` column.

Rule types:
- [ ] REQ §7.2 rows ⇔ SOLVER §4.3 rows ⇔ `ruleRegistry` keys ⇔ `rules/*.ts` files ⇔ `validate_policy_rules()` set ⇔ `he.admin.policies.rules` keys ⇔ `src/features/admin/policy/components/RuleParamsEditor.tsx` (the single file that renders every rule type's param form; there is no per-rule `ruleParamForms/` directory). Param names in SOLVER §4.3 ⇔ each rule's `defaultParams`.
- [ ] SOLVER §4.4 default policy ⇔ seeded `policy_versions.rules`.

Request fields:
- [ ] REQ §5.1 ⇔ DATA_MODEL `requests` (and `request_templates` mirror) ⇔ `schema.ts` ⇔ `he.requests.fields` ⇔ UX_FLOWS form ⇔ SOLVER §2 `Request`. Flag required/nullable mismatches and flexibility step lists (0/15/30/60/120/'day').

Notifications:
- [ ] UX_FLOWS §6.1 (canonical, 24 rows, incl. the Sadran-only `window_closed_solve_now`/`publish_reminder`, `status_changed`, `car_care`, `waitlist_contested`, `waitlist_resolved`) ⇔ DATA_MODEL §2 `notification_event` (value = snake_case of the `notif.*` suffix) ⇔ ARCHITECTURE §9 list ⇔ SQL ⇔ `he.notif.*` ⇔ an emitter per event ⇔ `inbox` + `push` template rows per event in the seed (+ seven `whatsapp` variants: shift, merge_passenger, merge_driver, deny, external, chauffeur, reminder). REQ §9 prose names nothing outside the list. Names: `enqueue_notification`, `notifications`, `push_outbox`, `notification_templates`, `profiles.muted_events` (anything else — `notify`, `notification_prefs`, templates in `app_settings` — is drift).

Weekly cycle:
- [ ] REQ §4 defaults ⇔ `department_settings` column defaults ⇔ seed ⇔ ARCHITECTURE §10. Exactly one `cron.schedule` (`app_tick`, `*/15 * * * *`, `app.tick()`) ⇔ DATA_MODEL §6 step 17 ⇔ ARCHITECTURE §10; tick sub-functions `advance_week_phases`, `send_due_reminders`, `expire_proposals`, `drain_push_outbox`, `housekeeping` exist. `week_phase` = `upcoming, open, solving, published, live, archived`.

Requests write path:
- [ ] `pg_policy` has no INSERT/UPDATE policy on `requests`; `submit_request(payload jsonb)`, `withdraw_request`, `set_manual_boost`, `try_auto_approve` exist (DATA_MODEL §3.6, ARCHITECTURE §6.1).

Solver:
- [ ] Suggestion order REQ §7.1 (1–6) ⇔ SOLVER §3.11 ⇔ `suggest.ts`. Suggestion kind → `proposal_type` mapping SOLVER §3.15 ⇔ `validate_proposal_payload()` ⇔ the composer (`src/features/proposals`). `SolverConfig` defaults ⇔ REQ §13.10–11 ⇔ `department_settings` defaults.
- [ ] Reason codes in `reasons.ts` ⇔ SOLVER §3.13; every `reasonCode` literal in `src/solver` has a template.
- [ ] Module list SOLVER §3 ⇔ files in `src/solver/`.
- [ ] Purity: `grep -rln "from 'react'\|@supabase\|@/integrations\|@/i18n\|Date.now\|Math.random" src/solver` is empty.

RLS and security:
- [ ] Every table in migrations appears in DATA_MODEL §4.3 and vice versa; each has `enable`+`force` and no `for all`/`using (true)` on writes.
- [ ] REQ §10 (drafts hidden, phone via `phone_of`) reflected in policies.

Time:
- [ ] `grep -rn "timestamp without time zone\|::timestamp\b" supabase/migrations` empty; `grep -rn "getHours()\|getDay()\|toLocaleTimeString" src --include=*.ts --include=*.tsx | grep -v lib/time` empty.

Hebrew placement:
- [ ] `grep -rnP "[\x{0590}-\x{05FF}]" src supabase/functions --include=*.ts --include=*.tsx | grep -v "src/i18n/he.ts\|src/solver/reasons.ts"` is empty; SQL Hebrew only in seed/template inserts (`notification_templates`, `ride_types`, `destinations`).

Docs vs docs and meta:
- [ ] Each derived doc's "Derives from REQUIREMENTS <version/date>" matches REQ status line.
- [ ] Paths: generated types `src/integrations/supabase/types.ts`, seed `supabase/seed.sql`, script `npm run db:types`, npm only, dev port `:8080` — consistent across ARCHITECTURE, DATA_MODEL, CLAUDE.md, `package.json`.
- [ ] Migration filenames are `YYYYMMDDHHMMSS_short_name.sql` everywhere (DATA_MODEL §6, CLAUDE.md, skills, actual files).
- [ ] Every item of CLAUDE.md "Consistency decisions (2026-09-06)" still holds in the code; if not, report as an owner decision (do not silently re-decide).
- [ ] `CLAUDE.md` folder map ⇔ tree; task→skill table ⇔ `.claude/skills/*`; `docs/MAINTENANCE.md` lists every skill and agent; CLAUDE.md "To be verified" items still open?

## 3. Report format
```
## Consistency review — <date>, commit <sha>

### Drift (fix required)
- [ ] week_phase: DATA_MODEL §2 'archived' vs ARCHITECTURE §5.1 'closed' vs SQL 20260907090000_extensions_and_enums.sql:12 'archived'. Fix: ARCHITECTURE → 'archived'.

### Not yet implemented (documented, no code)
- [ ] ...

### Undocumented (code, no doc)
- [ ] ...

### Clean
- request_status, proposal_status, ...
```

## Final verification
- [ ] Every item names both sides with file:line or §.
- [ ] No edits made unless asked (`git status` clean). If asked to fix: derived docs follow code unless the code contradicts REQUIREMENTS — then report as an owner decision; re-run this skill afterwards.
