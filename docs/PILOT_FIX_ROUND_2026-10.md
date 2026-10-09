# Pilot fix round — brief (2026-10-09)

The last round before the pilot. Released before it: `v2026.10.09-1` (+ repair migration `20261021100500`). Owner decisions: docs/TODO.md "Pilot release triage (owner 2026-10-08)", REQ §13.113 (rush hours), §13.114 (scheduled maintenance). Repro details for every bug: the QA-run sections of docs/TODO.md (IDs below).

## Rules for every work package
- **Reproduce first, on a QA week, then fix, then reproduce again** (REQ §13.103 e). Disposable stack `reqformqa` (API `http://127.0.0.1:61321`, DB container `supabase_db_reqformqa`, workdir `scratchpad/qastack`), QA weeks `qa-s6632` and `qa-s7012` (QA dirs `scratchpad/qa-run`, `scratchpad/qa-run11`), tools `qa:sadran` / `qa:member` / `scripts/qa/uiSession.mjs`. Never port 54321 for repro; never reset a stack.
- **Docs first:** the REQ wording for anything that is a rule, then UX_FLOWS / DATA_MODEL / SOLVER in the same change (CLAUDE.md hard rule 2).
- **SQL:** full `create or replace` copied from the **newest** migration that defines the function (grep supabase/migrations — several were rewritten this week); new migrations only, never edit an applied one; each package has its own timestamp range (below) so parallel packages never collide; new browser-facing RPCs → explicit grants + `department_isolation.sql`; copy for production via migration (new variants or rows whose body equals the default).
- **Tests:** unit tests per change; a SQL suite case per server change (`npm run db:test` on `reqformqa`: copy new migrations into the workdir, `supabase migration up --workdir`); an API case in `scripts/test-api.mjs` for each member/Sadran flow touched; an e2e spec (or an extension) for each user-visible flow — **written but not run by the package**; the lead runs the full e2e suite once at the end (it resets the local DB). `npm run check` green before reporting.
- Regenerate `types.ts` / `schema-current.sql` from `reqformqa` with `--workdir` when SQL changed; the owner's stack only `supabase migration up --local`.
- No commits by agents; the lead commits per package after review.

## Packages

### P1 — Publish & per-day autofill (migrations `20261022100000`…)
- **R8B2** The publish day picker pre-ticks days nobody solved as ready, so "רק ימים מוכנים" could publish unsolved days; the publish-anyway text is stale. A day is "ready" only when it was solved/reviewed (define precisely from `publication_readiness`, document it).
- **R8B1** Per-day autofill must place a multi-day series: starting with Tuesday while the other days are empty, a Monday–Thursday series is placed over its whole span (`place_series`), not left `UNMET_SERIES_NO_CAR`. Today's day restriction (`restrictInputToDay`, `applySolve.ts`, `qa:sadran autofill --day`) must let a series that touches the solved day through, with all its days.

### P2 — Solver suggestions & placement (migrations `20261022200000`…)
- **R7B2** Hide chauffeur suggestions for the pilot (no card action, no draft, no auto-proposal); keep the code behind a flag.
- **R8B12** Changing a trip type to הקפצה (Sadran `set_request_trip_type`, and the member's switch) places the request when a car is free.
- **R8B13** Chauffeur ride duration is identical between hand placement and the solver (one rule, both sides).
- **R8B14** Complementary one-way pairs get a pairing or a `chainOneWay` suggestion; the unmet reason must be true (no "אין רכב פנוי בגבעת חביבה" when a car is free).

### P3 — Notifications & proposals (migrations `20261022300000`…)
- **R8B7** No outcome notices before a day is published (accepting a merge, empty-title "שינוי בסידור שלך —", "כל הרכבים תפוסים", "שובצה").
- **R8B8** A host's `/p` page shows the guest's request as "הבקשה שלך" with the guest's times; a one-way join shown with a return.
- **R8B5** Ask-to-join on a private car never reaches the owner (`sent_at` null) and the Sadran has no in-app path.
- **R7M2 / R8M1** When a host ride is cancelled or the host leaves, every passenger/joiner gets a "what now" notice; the driver is told when someone asks to join.
- **R7U3** External proposal text: the question before the link, no contradiction, the composer's default matches the suggestion (public transport vs taxi).
- **R8B10** A member who does not drive is never addressed as the host/driver of a merge.

### P4 — Live changes & the board (migrations `20261022400000`…)
- **R8B11** Cancelling a needs-driver (chauffeur) ride creates a freed-car offer like any other cancellation.
- **R8U1 / R8U2** The ride sheet replaces a volunteer driver in one step; a host ride with a pending merge stays editable (driver, times) — no "ghost".
- **OB1 leftover** Move an already placed multi-day series to another car: all days, all-or-nothing.

### P5 — Rush hours (REQ §13.113; migrations `20261022500000`…)
- Department settings: morning window (default 07:00–09:30) + percentage (30), afternoon window (15:30–18:30) + percentage (20), Sun–Thu only; edited in the department management screen (admin).
- `timeAnchors.ts`: when converting "להגיע עד" → departure and "לצאת משם ב־" → return, stretch only the part of the drive inside a window by its percentage (iterate in small steps or compute the overlap exactly — document which); round as today (departure down, return up to the quarter hour). Estimate line: stretched minutes + "הערכה בלבד". Unit tests: no overlap, partial, full, both windows, Friday/Saturday, the 23:59 clamp.

### P6 — Scheduled maintenance (REQ §13.114; migrations `20261022600000`…)
- Data: reuse `car_maintenance_blocks` (start/end timestamptz, reason, created_by); remove the "X hours" path (`report_car_issue_unsafe_to_maintenance(p_hours)` → a start/end variant; keep old signature working or replace callers).
- UI: a "תקופת טיפול" dialog (start date+time, end date+time, may span days) from the car issue screen (unsafe: start = now) and from the car-details page; the car page and the cars list show "טיפול הבא: …".
- Siddur + board: the block is drawn in the car's column (already partly existing — check `blocks` in `WeekGrid`); draggable/resizable by the car's **current** responsible person, the Sadran and the admin (server re-checks `is_car_responsible` / `can_manage_operations`); others read-only.
- Rules: rides inside a new/extended period are flagged and members + Sadran notified (existing `maintenance_affects`); solver, auto-approve and freed-car offers never place inside a block (verify each).

### Done before this round (in `main`, not yet released)
- Car issue "mark handled" set `resolved_at` without `resolved_by` (`car_issues_resolution_ck`) — fixed (579eb1e).
- Bold car names for the viewer's own rides that day (siddur + board) (579eb1e).
- Inline hour list lost picks (TimeField15) (1b07def).

## After all packages
Full e2e suite (lead), then a QA run on a fresh week (all features + every fixed item), then release.
