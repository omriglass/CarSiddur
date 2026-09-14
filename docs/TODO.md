# Owner backlog — deferred items and possible bugs

Kept separate from `IMPLEMENTATION_PLAN.md` so the owner can triage. Items move out of here into REQUIREMENTS.md when scheduled.

## Deferred (needs product thinking)

- ~~Car responsible person, car care log, fault reporting~~ — scheduled 2026-09-09 as the car care portal (REQUIREMENTS, fleet section).
- **One-way rides: chauffeur availability** (owner, 2026-09-09). Members can mark time windows as "available to be a chauffeur". Riders can easily see when both a chauffeur and a car are available, so requesting a one-way ride is easy. Needs a `chauffeur_availability` table, a member screen to mark windows, and an availability overlay on the published siddur / request form.
- **WhatsApp bot feasibility** — `docs/WHATSAPP_BOT_RESEARCH.md` (2026-09-10, research only, not a commitment).

## Flaky / time-dependent e2e specs (found 2026-09-11 clean-slate run: 61 passed, 2 flaky, 3 failed) — all three items resolved by the 2026-09-14 audit + run (see the bottom of this file)

- ~~**`e2e/quick-request.spec.ts` fails every Friday after 10:00 Jerusalem time.**~~ Fixed 2026-09-14: both tests now call a new `freezeToWednesdayMorning(page, liveWeekStart)` helper (`page.clock.setFixedTime`, `date-fns-tz`'s `fromZonedTime`) right before navigating to the siddur page, pinning `quickContext.now` (`SiddurPage`'s `const now = new Date()`) to a Wednesday 08:00 Jerusalem instant of the seeded live week — safely before both hard-coded Friday slots (10:00 and 12:15) regardless of when the suite actually runs. `page.clock.setFixedTime` only freezes `Date`/`Date.now()`; other timers (TanStack Query polling, etc.) keep running normally. Verified: both tests pass standalone and alongside `board-coordination.spec.ts`.
- **`e2e/board-coordination.spec.ts` (one-way drop → tight edit → merge proposal) fails on a fresh database, `test.slow()` does not fix it — not a timing issue.** Investigated 2026-09-14: added `test.slow()` (kept in the spec) and re-ran alone; still fails at the same `expect(page).toHaveURL(boardUrl)` after clicking "הצע". Instrumented the page's `create_proposal` RPC request/response (temporarily, removed after diagnosis) and found the real cause: the RPC returns **400 `{"code":"P0001","message":"proposal_day_public"}`** — no toast or dialog is shown to the user at all (the composer just silently stays on `/proposals/new` with the "הצע" button still enabled; `region "Notifications alt+T"` in the DOM snapshot is empty). Root cause: the spec's own `publishedFixtureWeek(week)` fixture calls `publish_siddur`, which publishes the *entire* fixture week; the test then drags a request onto a ride to create a Sadran (`created_via: 'sadran'`) merge proposal for that same now-published day — exactly what `20260910098000_reject_proposals_on_published_day.sql`'s `proposal_day_public` guard (owner decision, hardening pass, `create_proposal`/`send_proposal`) deliberately forbids except for `ask_to_join`. This is not caused by the 2026-09-11 refactor and is not a flake: it fails deterministically on every run against the current schema, because the fixture and the flow under test now contradict an explicit, later app decision. Two secondary findings worth separate tickets: (1) the composer let the Sadran *prepare* a merge on a day the board already knows is published, so the only feedback is the `proposal_day_public` error after the click (`useCreateProposalMutation` does have `onError: showErrorToast` and the code is mapped to `he.errors.proposalDayPublic`, so a toast should appear — the agent's DOM snapshot showed none; confirm by hand, sonner toasts auto-dismiss). Better fix: hide/disable "prepare merge" and the drag-to-merge target on published days, mirroring the SQL guard; (2) the spec itself needs a redesign (e.g. drive the merge proposal on an *open*/*solving* day before publishing, or split "publish the earlier ride" from "propose the merge" into separate fixture weeks) since publishing the whole week before testing Sadran-composed proposals on it is no longer a valid setup. Not fixed — handing off per scope (spec redesign needs a product decision on which phase the merge-proposal flow should be tested against; the silent-failure UI gap is a `ui-dev`/`solver-dev`-adjacent app finding, not something to patch here).
- `e2e/board.spec.ts` "moving a ride via the sheet's car selector" and "dragging an unmet request creates a ride" flip between pass, flaky and fail depending on machine load — suspected pure timing; not investigated.

## Possible bugs (could not reproduce yet)

- ~~**Standalone unmet drop is not overlap-checked against other rides**~~ — fixed 2026-09-14 (`isUnmetDropValid` checks the target car's rides when there is no host; tests added). Original note: (found 2026-09-11 while extracting `src/features/sadran/board/dropValidity.ts`, behaviour preserved as-is). `isUnmetDropValid()` returns `!host || !wouldOverlap(...)`: when the unmet request is dropped onto a car with no merge host, the `!host` branch short-circuits to valid, so only maintenance blocks (`unavailable()`) are checked, not existing rides on that car. `edit_ride`/`assert_car_chain` in SQL still reject a real overlap, so the effect is a misleading green drop target followed by an error toast, not a bad ride. Decide: check overlap client-side too (one extra `wouldOverlap` call) or accept.

- ~~**Chauffeur suggestion is not gated on a free shared car**~~ — fixed 2026-09-14 (owner: only when a car is available): `findChauffeurCar` in `src/solver/suggestions.ts` requires a free shared car at home for the chauffeur window and a seat fit with the extra adult; `suggestions.test.ts` added. Original note: (found 2026-09-11 while removing dead solver exports). `docs/SOLVER.md` §3.3, §3.11 item 5 and the §7.1 test-matrix row say a `chauffeur` suggestion appears only when a shared car is free at home for the chauffeur window and the load `sum(served) + (1, 0, 0)` fits — `chauffeurLoad()` in `src/solver/seatFit.ts` exists for exactly this, but `src/solver/suggestions.ts` emits `kind: 'chauffeur'` unconditionally in both places and nothing calls `chauffeurLoad` outside its unit test. Either wire the gate (solver-dev, plus a `suggestions.test.ts` row) or amend SOLVER.md; owner decides which. Plan item D12.

- **"Blocked by <ride-id hash>" label on mobile** when viewing requests that were not auto-approved. Not found in the source (2026-09-09 grep for blocked/blockedBy). Owner: please capture a screenshot with the screen name.

## Low priority (2026-09-10 hardening audit, `docs/HARDENING_2026-09.md` §4)

- ~~Edge functions contain inline Hebrew error strings (hard rule 3)~~ — done 2026-09-14: functions return machine codes only (`{ error: { code } }`), the frontend maps them via `he.*`; `eslint.config.js` now bans Hebrew literals under `supabase/functions/**/*.ts` (docs/HARDENING_2026-09.md §4).

## ~~Add passengers to a ride by button~~ — done 2026-09-14 (REQ §13.85: `add_ride_passengers`/`remove_ride_passenger`, "+ נוסעים" on the siddur ride sheet and the board ride sheet)

Owner decisions (2026-09-09): anyone can add named passengers (self, spouse, kids) to any published ride, including private cars (posting a private car means willing to share). The driver gets a notification naming who added whom, unless the driver did it. Built on the `ride_passengers` table from F3 (REQ §13.82); see REQ §13.85 once landed.

- ~~Department switcher lists only own memberships~~ — resolved 2026-09-14 by amending REQ §13.52: multiple departments are out of the MVP; future = see + request in every department a member belongs to.

## To confirm

- ~~`skip_nonce_check = true`~~ — kept with a justification comment (2026-09-14): the Supabase CLI template itself states it is required for local Google sign-in; local-only, the hosted Auth settings are set by hand.

## Owner dump 2026-09-11 → 2026-09-13 (triaged 2026-09-14, owner answered all questions 2026-09-14 — **all items built 2026-09-14**, see per-item notes and the open points at the end)

Ordered: bug first, then small features, then the statistics group, then the larger features. Open questions were marked **Q**; the owner's answers (2026-09-14) are recorded inline as **A**. Work order: B1 → F1 → F2 → S1–S4 → F3 → F4 → F5, recap between groups.

### ~~B1~~ ✅ done 2026-09-14 — Bug: a short single-day request is filed as a multi-day series (or fails with the "…עד 23:59" error)

- **Root cause (found, not fixed).** `RequestForm` defaults `day` to the weekday of the member's *last* request (`buildDefaultDay`) and sets `returnDay` to that same day. The day picker only moves `returnDay` forward (`if (currentReturnDay < next)`), never back. So when the default lands on, say, Saturday and the member picks Sunday, `returnDay` silently stays Saturday, the multi-day hint stays hidden (it is gated on the "חזרה ביום אחר?" link being open) but `performSubmit` treats `returnDay !== day` as a series and calls `submit_series_request` — a 7-day hold. The "23:59" toast is the same path: the series' first leg is `depart → 23:59`, and `assert_same_day_window` / the quarter-hour constraints reject it in some configurations (`ride_must_end_same_day` → `he.boardCoordination.sameDayOnly`).
- **Not from the last 5 commits.** Introduced with the multi-day UI (`5263bbf`, collapsed link `0fe5023`); the 2026-09-11 refactor only changed types in `features/requests`.
- **Fixed 2026-09-14:** `isSeriesSubmission`/`returnDayAfterDayChange` in `features/requests/series.ts` (unit-tested), used by `RequestForm`; REQ §13.77 bullet added. Original plan: in the day picker's `onChange` reset `returnDay` to the new day unless the return-day picker is open; gate `isSeriesRequest` in `performSubmit` on `returnAnotherDay` exactly like `isMultiDay` already is; add a `RequestForm` unit test for "pick an earlier day → still a single-day request".

### ~~F1~~ ✅ done 2026-09-14 — Siddur: hide a private car on days it has no rides

- Done 2026-09-14: `components/weekGridCars.ts` (`hideIdleTemporaryCars`) filters the `WeekGrid` rows on the siddur and, since the owner's follow-up the same day, on the board (REQ §13.80); the phone lists never had car rows.
- **Q1.** "No future rides the same day" — hide the car only on days with zero rides (my reading), or also hide it *after its last ride of today has ended*? The second reading makes the siddur change during the day.
  **A1.** Only on days with zero rides.

### ~~F2~~ ✅ done 2026-09-14 — Sadran: per-week custom closing time + three-state "new request" button (REQ §13.81; `set_week_close_at`, `window_changed` event, `NewRequestButton`)

- `weeks.close_at` already exists per week (default filled from department settings), so this is a Sadran-only "change closing time for this week" action (RPC + confirm dialog in the board's kebab menu), plus a `request_window_changed`-style member notice. Rarely used, so it lives behind the menu, not on the main screen.
- Button states (Home / siddur "בקשה חדשה"):
  1. next week open → **"בקשה לשבוע הבא"**
  2. closed, not yet published → disabled **"סידור בהכנה..."**
  3. published, until the following week opens → **"רשימת המתנה לשבוע הבא"** (opens the request form in waiting-list mode for that week)
- **Q2.** Should members be notified when the Sadran shortens the window (push + inbox, e.g. "השבוע הבקשות נסגרות ביום ג' 19:00")? I assume yes.
  **A2.** Yes, notify members.
- **Q3.** Quick requests on the *live* week (the "+" from an empty slot / car-now) stay as they are and are not affected by this button — confirm.
  **A3.** Confirmed — live-week quick requests are unaffected.
- **Q4.** May the Sadran also *extend* the window (later than the default), or only shorten it? Extending would push against `publish_at` (`close_at <= publish_at` constraint).
  **A4.** Both — the Sadran may shorten or extend the window.

### ~~F3~~ ✅ done 2026-09-14 — Board "שמירת זמן" (reservation): optional named people (REQ §13.82; `ride_passengers` + `set_ride_passengers`, reusable for the "+ נוסעים" item above)

- Today a reservation is a manual ride with a free-text description only. Add an optional people picker (members + their children, same picker as the request form); chosen people see the ride under "my rides" and get the usual ride notifications.
- Overlaps with the existing backlog item "add passengers to a ride by button" (priority 3 above): both need a `ride_passengers`-style link from a ride to people who have no request. Propose building that table once and using it for both.
- **Q5.** Should the first person picked be treated as the driver of the reservation, or is a reservation always driverless with "people on board" only?
  **A5.** The first person picked is the driver.

### ~~S~~ ✅ done 2026-09-14 — Statistics group (`department_stats` RPC + stats dashboard; REQ §13.78 "Extended 2026-09-14")

- **S1 Utilization counts the turnaround buffer.** Each ride's occupied time = duration + `department_settings.turnaround_minutes` (capped at the day's end), so one 8-hour ride ≈ a 3-hour + a 4-hour ride. SQL-only change + test row in `department_stats.sql`. Small.
- **S2 Same-day sharing indicators** (owner 2026-09-14: **no combined score for now**, show the three elements only in one tile):
  - *utilization by people*: passenger-seats used ÷ seats available across the day's rides on shared cars.
  - *fragmentation*: number of distinct rides each shared car had each day, summed over cars and days (baseline = one ride per car per day, so higher means more sharing of the same car within a day).
  - *one-way fulfilment*: one-way requests served ÷ one-way requests filed.
- **S3 Same-day cancellation rate.** `rides.cancelled_at` already exists, so it is a plain query (`cancelled_at::date = starts_at::date` in Asia/Jerusalem) — no memoization needed. Small. **Q7.** Denominator: all rides, or all cancelled rides?
  **A7.** Rate = same-day cancellations ÷ all cancellations. Cancelling is fine; last-minute cancelling is the problem.
- **S4 Requests per hour of day** — histogram of `depart_at` hour (Asia/Jerusalem) over the selected range. Small.

### ~~F4~~ ✅ done 2026-09-14 — Waiting list: offer joinable rides within ~10 km before waitlisting (REQ §13.83; `joinable_rides_for_request`, `department_settings.join_radius_km`)

- After a member submits into the waiting list (published/live week), show a second dialog listing existing rides that day whose destination is within ~10 km of theirs and whose time window overlaps (±flexibility), with "ask to join" (existing `join_ride_id` flow) and a WhatsApp link to the driver. `destinations.lat/lng` exist, so a haversine distance works for preset destinations.
- **Q8.** Free-text destinations have no coordinates — skip them, or fall back to same `zone`?
  **A8.** Skip free-text destinations.
- **Q9.** Is the 10 km radius a department setting or a constant? I'd make it `department_settings.join_radius_km` default 10.
  **A9.** Department setting (`join_radius_km`, default 10).
- **Q10.** Should this also apply *before* publishing (open week), as a hint "someone is already going near there"? Owner text says waiting list only; I'll keep it to published/live weeks.
  **A10.** Waiting list only (published/live weeks). Purpose: "you are on the waiting list, HOWEVER here is another option instead of waiting".

### ~~F5~~ ✅ done 2026-09-14 — Solver: spread rides across cars to balance mileage (REQ §13.84; `Car.mileageKm`, `car_mileage_totals`, `CAR_BALANCED_MILEAGE`)

- When car choice is otherwise indifferent (no preferred car, no seat/trunk constraint, both free), pick the car with the lowest cumulative distance. Needs per-ride distance (`destinations.distance_km`, 0 for unknown free-text) and a per-car mileage total fed through `buildSolverInput`; tie-break happens in the car-selection step (`timeline`/`improve`), after every existing consideration, and stays deterministic (`id` tie-break last).
- **Q11.** Mileage window: this week only, or a rolling window (e.g. same `lookbackWeeks` as fairness, 3 weeks)?
  **A11.** Rolling window.
- **Q12.** Should the Sadran see it as a reason ("נבחר רכב 2 לאיזון ק"מ") on the board? I assume yes via a new `reasonCode`.
  **A12.** Show it as a reason, but never coerce — no confirmation popup when the Sadran moves the ride to another car.

### Open points from the 2026-09-14 build (owner to decide / confirm)

- **F5 ranking → policy option (owner 2026-09-14):** `carChoice: 'pack' | 'spread'` on the priority policy — `spread` (mileage above best-fit, better mileage balance) vs `pack` (best-fit above mileage, keeps whole cars free). **Done 2026-09-14** — "בחירת רכב" control in the policy editor, saved per policy version (`policy_versions.settings`).
- **F2 4th button state (owner 2026-09-14):** the button always refers to *next* week; when next week is not open yet it is greyed out with the same "בקשה לשבוע הבא" label (never "this week"). **Done 2026-09-14.**
- **F4 contact channel (owner 2026-09-14):** keep the in-app ask-to-join AND add a WhatsApp quick link to the driver on top — phone numbers are not secrets inside a department (everybody knows everybody); REQ §10 amended accordingly. **Done 2026-09-14** (`driver_phone` on `joinable_rides_for_request`, WhatsApp button in `JoinableRidesDialog`).
- **F3 children**: a reservation's people picker takes department members (and their children as `child_id` rows); children are not notified. Editing people on an existing reservation happens from the board `RideSheet`.

## Follow-ups built 2026-09-14 (afternoon)

- **One passenger list per ride (REQ §13.85, owner decisions 1–5 of 2026-09-14):** `v_board_rides.people` (driver, requesters, companions, children, guests, directly added), `add_ride_passengers` open to every department member on published/live rides, `remove_ride_person(key)` for any non-driver row (companion/child/guest rows edit the underlying request; a requester row withdraws that request), notifications to the driver, the added/removed member and a removed child's parents. Siddur/board labels, ride sheets, Home cards and the Excel export read the one list; "בקש/י להצטרף" is gone from the ride sheet (direct "+ נוסעים" with "אני"); the joinable-rides dialog joins directly ("הצטרפות לנסיעה") and withdraws the waitlisted request. Statistics count added people.
- **Policy score visible and fixed:** the board policy chip shows the current board's weighted-coverage score ("… · 87%") and each policy's score in its dialog (client-side preview, nothing stored); `department_stats.policyScore` now selects weeks by target week instead of publication date (the owner's "last week" showed nothing because the siddur was published the Wednesday before); publishing keeps every policy's score when one policy/request cannot be scored (per-policy tolerance, logged, never silent).
- **Stats:** the three same-day sharing indicators are three plain tiles in the grid (owner: the combined card read as one muddled figure).
- **E2E audit + run (2026-09-14):** `docs/E2E_AUDIT_2026-09-14.md` (24 valid, 3 updated). Full run on a reseeded local stack: 64–65 passed; the remaining failures were spec/fixture problems, all fixed and re-verified standalone — `published-week.ts` sent zero-count policy entries that `assert_publication_scores` rejects once a week has requests (now sends no score arrays, which `publish_siddur` allows), `one-way-consent` published one step too late (the driver's "בטל נסיעה" needs a published ride), and `admin.spec` clicked the car-name cell, which is a link to `/cars/:carId`. No product bug surfaced. Note: `e2e/global-setup.ts` resets the local database by itself.
- **Sliding ride labels on the grid (owner, 2026-09-14):** built — the readable part of a ride block is `position: sticky` under the header, capped by the block's bottom (`WeekGrid.tsx`, UX_FLOWS §3.5); verified with an 8-hour seeded ride.
