# Planning ahead — build plan (REQ §13.154, owner 2026-10-26)

Branch `feature/planning` (cut from `main` at `ed30e35`). Nothing merges to `main` until the owner says so. Mockups the owner approved: the "C2" artboards (phone + computer) of the planning-helper canvas.

## 1. Decisions (owner, 2026-10-26)

| # | Decision |
|---|---|
| D1 | A reservation is a **saved request with dates**, the same table as repeating requests (`request_templates`), schedule `weekly` \| `dated`. Rejected: draft requests in far weeks (too many request readers would have to learn to skip them). |
| D2 | Not a request: invisible to the Sadran, the board, the solver, stats and notifications; no car held. Any day can be reserved, also a "full" one. |
| D3 | Up to three months ahead, only in weeks not open yet; multi-day allowed. A day in an open week opens the normal form. |
| D4 | When the week opens: a suggestion on /my (as item 76): "use" prefills the form, "not needed" cancels. No new notification. Unused → expires when the week closes. |
| D5 | Everyone in the department sees everyone's reservations (never `notes`); only the owner edits/cancels. |
| D6 | Month view: count per day (blank when 0), shade = share of shared cars taken at the busiest part of the day. Tap day → list → read-only details. |
| D7 | Helper: day circles, tap → picker (morning 07–12, afternoon 12–17, evening 17–22, whole day 07–22, none); וגם (same week) / או; stars ★★★/★★/★ (1/2/2 options) + orange top bar on the month. Days ≥ full get no stars. |
| D8 | Score = `weekCost × weeksAhead + max(0, occupancy − good)`; occupancy = cars taken ÷ (shared cars available × multiplier). Mode "reservations": multiplier 1, typical usage 0. Mode "reservations + typical usage": multiplier `planning_car_multiplier` (1.2), one-off reservations only. Settings: full 80 %, good 75 %, week cost 10 %, multiplier 1.2. |
| D9 | Typical usage: last 8 finished weeks, published rides on shared cars, peak concurrent cars per weekday × part; < 4 weeks → "not enough data". Member-readable, percentages only. |
| D10 | Calendar overlay: the experimental calendar (item 126 b), one block per event per day. |
| D11 | Priority: requests remember the reservation (`template_id` + new `requests.reserved_at`); new rule type `plannedAhead` `{ days: boolean[7], minLeadDays: 14 }`, not in any policy until an admin adds it. |
| D12 | Opening the full statistics screen to members: a **separate** item after this one. |

Open point I assumed (say if wrong): in a week that is already open, the month view's day count shows that week's **requests** (not reservations — those turned into suggestions), so the picture stays continuous.

## 2. Data (one concern per migration)

1. `20261029100000_template_schedule_enum.sql` — `create type template_schedule as enum ('weekly','dated')` (alone in its file).
2. `20261029100100_request_template_reservations.sql`
   - `request_templates`: `schedule template_schedule not null default 'weekly'`, `planned_date date`, `planned_until date` (last day of a multi-day reservation, null = single day), `cancelled_at timestamptz`, `used_request_id uuid references requests on delete set null`; check: `dated` ⇔ `planned_date is not null`; `dated` rows ignore `depart_dow/return_dow` (kept null).
   - `requests.reserved_at timestamptz` — when the reservation a request was filed from was made (copied by `submit_request` when `template_id` points to a `dated` template of the same requester; immune to the template being deleted later).
   - `department_settings`: `planning_full_pct smallint 80`, `planning_good_pct smallint 75`, `planning_week_cost_pct smallint 10`, `planning_car_multiplier numeric(3,2) 1.20` (+ range checks).
   - Every existing reader of `request_templates` gets `schedule = 'weekly'` where it means "repeating": `v_request_template_suggestions` (rewritten to serve both: weekly by `depart_dow`, dated by `planned_date` in the open week that contains it), `save_request_template`, `stop_request_template`, `snooze_request_template`, `materialize_templates` (no-op). RLS on `request_templates` stays owner-only — other members read reservations only through the RPC below (so `notes` never leaks).
3. `20261029100200_reservation_rpcs.sql`
   - `save_reservation(payload jsonb, p_id uuid default null) → uuid` — same payload shape as `submit_request` (the form builds it once), validated with the same field checks; refuses a date in an open/past week or more than 3 months ahead; owner only for edits.
   - `cancel_reservation(p_id uuid)` — owner only.
   - `planning_month(p_department_id, p_from date, p_to date) → jsonb` — `member_of`; per day: `reservations` (id, requester name, route, times, trip type, people counts, children names, guest names, `mine`), per part (`m`/`a`/`e`) reservation counts, shared cars available (active shared cars minus maintenance overlapping the part), and for days in open/later-phase weeks the request counts. Never `notes`.
   - `typical_usage(p_department_id) → jsonb` — `member_of`; 7 × 3 peak shared cars in use averaged over the last 8 finished weeks, `weeks` used, `sharedCars`; null grid when < 4 weeks.
   - Grants to `authenticated`; all four classified in `department_isolation.sql`.
4. `20261029100300_planned_ahead_rule.sql` — `validate_policy_rules()` known set gains `plannedAhead` (full `create or replace`).

## 3. Solver

- `src/solver/rules/plannedAhead.ts`: `{ days: boolean[7], minLeadDays: number }`, normalization `unit`; value 1 when `request.reservedAtMs` exists, `departMs − reservedAtMs ≥ minLeadDays` and any request day's weekday is selected; else 0. Registry + `RULE_PLANNEDAHEAD_DESC` in `reasons.ts` + rule tests; `Request.reservedAtMs?` in `types.ts`; bridge maps `requests.reserved_at`. `functions:bundle`. SOLVER.md §4.3 row.
- Admin policy editor: param form (seven weekday switches + min lead days); `policyView/ruleExplain.ts` explanation.

## 4. Client

- **Ranking module** `src/features/planning/rank.ts` (pure, unit-tested): parts, occupancy per day/part, option building for וגם/או, scoring, star tiers, "full" exclusion, mode switch. All four settings come from `department_settings`.
- **Page** `/plan/:dept` (`paths.plan(dept)`), entries in the siddur and /my menus. Phone: header, helper card, month card. Computer (≥ 1024 px): side panel (helper + legend) + large month. Month navigation over the current month and the next two.
- **Day sheet**: the day's reservations at a glance; tap → read-only details (reuses the request detail rendering with all actions off); own reservations: edit / cancel; "שריון חדש ליום הזה".
- **Reservation form**: `RequestForm` gains `variant: 'reservation'` — no week window, no plan B / repeat-weekly switches, date limited to non-open weeks within 3 months; submit → `save_reservation`. (Risk: `RequestForm` is 1.6 k lines; the variant is kept to a few switches and covered by a form test.)
- **/my**: `TemplateSuggestions` shows dated suggestions with "use" and "not needed" (= cancel); "use" passes `template_id` as today.
- **Calendar overlay**: `features/calendar` source fetched for the month range; `monthBlocks.ts` turns events into one block per day.
- **Admin settings**: the four planning numbers in the department settings screen.
- i18n: `he.planning.*`, `he.policy.rules.plannedAhead.*`.

## 5. Tests

- SQL `supabase/tests/planning.sql`: save/edit/cancel (owner only, open week refused, > 3 months refused), another member sees a reservation via `planning_month` but never `notes` and cannot read the row directly, per-part counts and car availability (private car and maintenance excluded), dated suggestion appears only when its week is open and disappears once used, `reserved_at` copied by `submit_request`, weekly paths unaffected by a dated row, `typical_usage` < 4 weeks → null and a seeded 8-week grid. Plus `department_isolation.sql`, `rls_smoke.sql` (new grants), `test-api.mjs` (member A reads B's reservation without notes).
- Vitest: `rank.ts`, `plannedAhead` rule, month blocks, form variant, `TemplateSuggestions` dated card.
- Playwright `e2e/planning.spec.ts`: reserve two days → count shows on the month for another member → helper marks stars → open the week (fixture) → suggestion on /my → use → request carries the reservation.
- `npm run check`, `functions:bundle`, `db:test` + `test-api` and the new e2e on a **disposable stack** (never the owner's :8080/54321 data); generated `types.ts` / `schema-current.sql` from that stack.

## 6. Order

1. Docs (REQ 154 ✓, this plan, DATA_MODEL, UX_FLOWS, SOLVER, TEST_MAP) → owner review.
2. Migrations + SQL suite.
3. Solver rule + bridge + policy editor.
4. Ranking module + page + day sheet + reservation form + /my suggestions + settings.
5. Calendar overlay.
6. e2e, full checks, owner QA on the branch.
