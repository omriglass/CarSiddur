# Owner backlog — deferred items and possible bugs

Kept separate from `IMPLEMENTATION_PLAN.md` so the owner can triage. Items move out of here into REQUIREMENTS.md when scheduled.

## Deferred (needs product thinking)

- ~~Car responsible person, car care log, fault reporting~~ — scheduled 2026-09-09 as the car care portal (REQUIREMENTS, fleet section).
- **One-way rides: chauffeur availability** (owner, 2026-09-09). Members can mark time windows as "available to be a chauffeur". Riders can easily see when both a chauffeur and a car are available, so requesting a one-way ride is easy. Needs a `chauffeur_availability` table, a member screen to mark windows, and an availability overlay on the published siddur / request form.
- **WhatsApp bot feasibility** — `docs/WHATSAPP_BOT_RESEARCH.md` (2026-09-10, research only, not a commitment).

## Flaky / time-dependent e2e specs (found 2026-09-11 clean-slate run: 61 passed, 2 flaky, 3 failed) — all three items resolved by the 2026-09-14 audit + run (see the bottom of this file)

- ~~**`e2e/quick-request.spec.ts` fails every Friday after 10:00 Jerusalem time.**~~ Fixed 2026-09-14: both tests now call a new `freezeToWednesdayMorning(page, liveWeekStart)` helper (`page.clock.setFixedTime`, `date-fns-tz`'s `fromZonedTime`) right before navigating to the siddur page, pinning `quickContext.now` (`SiddurPage`'s `const now = new Date()`) to a Wednesday 08:00 Jerusalem instant of the seeded live week — safely before both hard-coded Friday slots (10:00 and 12:15) regardless of when the suite actually runs. `page.clock.setFixedTime` only freezes `Date`/`Date.now()`; other timers (TanStack Query polling, etc.) keep running normally. Verified: both tests pass standalone and alongside `board-coordination.spec.ts`.
- **`e2e/board-coordination.spec.ts` (one-way drop → tight edit → merge proposal) fails on a fresh database, `test.slow()` does not fix it — not a timing issue.** Investigated 2026-09-14: added `test.slow()` (kept in the spec) and re-ran alone; still fails at the same `expect(page).toHaveURL(boardUrl)` after clicking "הצע". Instrumented the page's `create_proposal` RPC request/response (temporarily, removed after diagnosis) and found the real cause: the RPC returns **400 `{"code":"P0001","message":"proposal_day_public"}`** — no toast or dialog is shown to the user at all (the composer just silently stays on `/proposals/new` with the "הצע" button still enabled; `region "Notifications alt+T"` in the DOM snapshot is empty). Root cause: the spec's own `publishedFixtureWeek(week)` fixture calls `publish_siddur`, which publishes the *entire* fixture week; the test then drags a request onto a ride to create a Sadran (`created_via: 'sadran'`) merge proposal for that same now-published day — exactly what `20260910098000_reject_proposals_on_published_day.sql`'s `proposal_day_public` guard (owner decision, hardening pass, `create_proposal`/`send_proposal`) deliberately forbids except for `ask_to_join`. This is not caused by the 2026-09-11 refactor and is not a flake: it fails deterministically on every run against the current schema, because the fixture and the flow under test now contradict an explicit, later app decision. Two secondary findings worth separate tickets: (1) the composer let the Sadran *prepare* a merge on a day the board already knows is published, so the only feedback is the `proposal_day_public` error after the click (`useCreateProposalMutation` does have `onError: showErrorToast` and the code is mapped to `he.errors.proposalDayPublic`, so a toast should appear — the agent's DOM snapshot showed none; confirm by hand, sonner toasts auto-dismiss). Better fix: hide/disable "prepare merge" and the drag-to-merge target on published days, mirroring the SQL guard; (2) the spec itself needs a redesign (e.g. drive the merge proposal on an *open*/*solving* day before publishing, or split "publish the earlier ride" from "propose the merge" into separate fixture weeks) since publishing the whole week before testing Sadran-composed proposals on it is no longer a valid setup. Not fixed — handing off per scope (spec redesign needs a product decision on which phase the merge-proposal flow should be tested against; the silent-failure UI gap is a `ui-dev`/`solver-dev`-adjacent app finding, not something to patch here).
- `e2e/quick-request.spec.ts` "clicking a cell within the buffer of an existing ride falls back to another car" — the "הרכב הזה תפוס" warning does not appear; fails on committed HEAD in the same isolated environment as well as after REQ §13.93 (seen at night, 2026-10-04/05), passed in two evening runs — suspected time-of-day dependency like the car-now spec. Not investigated yet.
- ~~`e2e/siddur-mobile.spec.ts` car-now~~ — fixed 2026-10-05: the page clock is frozen to midday (car-now only counts free time inside the department's day window from 06:00, so it failed every night, including CI's 03:00 nightly run).
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

## Owner dump 2026-09-14 (evening, "version 1.2") — triaged 2026-09-15, owner answered Q1–Q9 the same day; **bugs B2–B5 built 2026-09-15, features F6/F7 on hold by owner decision ("only fix the bugs") — answers kept below for when they are picked up**

Order once approved: bugs B2–B5 first (small, one afternoon), then F6, then F7. Every item links the doc section that governs it; F6/F7 get their REQ §13 item written first for owner review.

### ~~B2~~ ✅ done 2026-09-15 — Bug: "סוג נסיעה" chips and "רכב מועדף" select render left-to-right in the request form

- Root cause (confirmed in code): the Radix primitives behind `RideTypeChips` (`ToggleGroup`) and `Select` resolve their direction with `useDirection()`, which falls back to **`ltr`** when the app mounts no `DirectionProvider` — each of them then stamps `dir="ltr"` on its own DOM root, overriding the ambient `<html dir="rtl">`. `RideTypeChips` even says `justify-start`, which under that forced `ltr` means *left*.
- Fix: mount `<DirectionProvider dir="rtl">` (from `@radix-ui/react-direction`, already a transitive dependency) once around the tree in `src/main.tsx`. One-line, app-wide — it also corrects every other Radix primitive (dropdown/kebab menus, tabs, sliders, other selects) that today silently runs `ltr`. Needs one visual pass over board kebab/eye menus and the admin selects after the change. UX_FLOWS §1 gets one sentence ("RTL: `<html dir>` + Radix `DirectionProvider`").
- Regression test: a Vitest render of `RideTypeChips` inside the provider asserting `dir="rtl"` on the group.

### ~~B3~~ ✅ done 2026-09-15 — Bug: "לאן?" should read "מאיפה?" when the trip shape is "חזור בלבד"

- `RequestForm.tsx` labels the destination field with `field.destination` ("לאן?") regardless of `tripShape`. Add `field.destinationFrom` ("מאיפה?") and pick it when `tripShape === "one_way_from"`. Form-only, no behaviour change (the stored field is still the destination). UX_FLOWS §3.4 mockup note + §10 key table row.
- Regression test: `destinationLabel.test.ts` (pure key choice per trip shape).

### ~~B4~~ ✅ done 2026-09-15 — Bug: a single date must always carry its weekday (e.g. "16.9 יום ד'")

Inventory of places that print a date with no weekday today:
- **SQL notification vars** (`notification_context`, `20260907093700`): `day` = `DD/MM` and `date` = `DD/MM/YY`. So every inbox/push body built from `{{day}}` reads "16/09 08:00–12:00" — no weekday at all — and a WhatsApp template rendered server-side ("ב{{day}} {{date}}") would read "ב16/09 16/09/26". (The Sadran's composer builds its own vars client-side, where `day` is "רביעי" and `date` is "16.9", which is why the proposal WhatsApp text looks right while notifications don't.)
- `ride_change` template (seed, "בקשה לרכב ב־{{date}} …") uses `date` only.
- `publish_siddur` grouped notice lines (`20260910096000`): `DD/MM HH:MI`.
- TS: `RideChangeAnswers.tsx` ("d/M/yy HH:mm"), `ProposalComposerScreen.tsx` combined-window line, `BoardScreen.tsx` conflict dialog `date`, `InboxPage.tsx` received-at stamp. Also three different numeric styles coexist (`d/M/yyyy`, `dd.MM`, `d.M`).
- Fix plan: one canonical helper on each side — TS `formatDayDate(instant)` in `src/lib/dayLabels.ts` (next to `weekdayLabel`), SQL `day_date_label(timestamptz)` built on the seeded `weekday_labels` table (new migration; `notification_context.day` switches to it; `date` keeps the numeric form for templates that want both). Seed: `ride_change` body "ב{{day}}". **Production templates are admin-editable DB rows**, so the migration updates only rows whose `body` still equals `default_body` (untouched ones) and leaves owner-edited copy alone. Replace the TS call sites above with the helper; `dayLabel.ts` (request cards, "ד' 16.09") adopts the same format.
- Regression test: `dayLabels.test.ts` for the helper; one assertion in `notifications_semantics.sql` that `day` contains a Hebrew weekday letter.
- **CI red on 73d52b8 (2026-09-15):** the new `notifications_semantics.sql` item 8 ran after item 7, which leaves the session impersonating a non-existent user, so its audited inserts hit the `audit_log.actor_id` FK on a clean replay (hidden locally because the fixture week already existed). Fixed by re-impersonating the seeded member at the top of item 8. Playwright: `proposal-retry.spec.ts` and `one-way-consent.spec.ts` still asserted the old "25/1/2043" / "ראשון" text — updated to "א׳ 25.1". Full Playwright run on the reset stack: 65 passed, `board.spec` car-selector flaky (passed on retry, known), and `siddur-mobile.spec` "car-now" failed by time of day — its fixture blocks every shared car at now±2h and the seed puts a real ride on the live week relative to `now()` (Tue 11:00–19:00 at the 09:50 run), so the insert hit `ride_turnaround_conflict`; the spec now parks overlapping seeded rides as `cancelled` (all three cancel columns, `rides_cancel_consistency_ck`) for the test and restores them. Re-run: 6/6.
- **Q1 (format).** Owner's example puts the date first: **"16.9 יום ד'"**. The app's existing card format is weekday first ("ד' 16.09" on request cards, "רביעי · 16/9/2026" on ride cards). Pick one for everywhere: (a) "יום ד' 16.9" (b) "16.9 יום ד'" (c) "ד' 16.9". I'd take (a): reads naturally in a sentence ("ביום ד' 16.9 בשעה 08:00") and on a card.
  **A1.** (c) "ד׳ 16.9" — weekday letter + geresh, then `d.M`.

### ~~B5~~ ✅ done 2026-09-15 — Bug: a named child is counted twice in the ride details ("X, Y ו ילד/ה 1")

- Where the text comes from: `src/lib/ridePassengerSummary.ts` (Sadran-only "נוסעים:" line on the siddur ride sheet, board ride sheet, unmet list). It lists names and then *reconciles* the request's seat counts (`adults`, `child_seats`, `boosters`) against the names it recognises — names come from three sources (`served` json, `childNames`, `people`/`added`), and any child name that reaches the list through a source the count logic doesn't subtract yields a leftover "ילד/ה 1". Exact path still to reproduce on the owner's data (which sheet, was Y picked as a child with a child seat or a booster) — first step of the fix.
- **Actual root cause (found 2026-09-15):** not the display code — the *data*. The form sent `child_seats` already including the selected named children, and `set_request_children()` (contract: "the row's counts include the currently linked children; subtract those, add the new selection") added them again, so every request with one named child under eight had `child_seats = 2`. Fixed client-side in `src/features/requests/seatCounts.ts` (`payloadSeatCounts`, unit-tested against the RPC's arithmetic); re-saving a request heals an already doubled row. The display code (`ridePassengerSummary`) was right all along and is unchanged; named people were already listed without a child marker.
- Original plan (superseded): **the final result never says who is a child**. Rebuild the summary from the one unified `people` list (`v_board_rides.people`, REQ §13.85 — driver first, then requesters/companions/children/guests/added, deduplicated by `key`), plain names only. Seat-kind stays in the data (needed for seat capacity, `peopleSeatLoad`/`freeSeats`) but is not rendered. `ridePublicDetails` (member view) likewise lists child names plainly (it already does). REQ §13.85 gets one dated sentence; `ridePublicDetails.unnamedChild*` keys are retired.
- **Q2 (unnamed seats).** A request can still carry seats with no name behind them (e.g. "2 adults", only the requester named). Today those print as "מבוגר/ת 1" / "ילד/ה 1". Proposal: one neutral placeholder, "ועוד 1" / "ועוד {{n}} נוסעים", no adult/child split. OK?
  **A2.** No — unnamed seats keep the adult/child split ("מבוגר/ת 1" / "ילד/ה 1"); only *named* people lose the child marker.
- Regression test: `ridePassengerSummary.test.ts` case "named child + requester → exactly two names, no count".

### F6 — Feature (v1.2, **on hold**, owner 2026-09-15): "תכנון קדימה" — see the next two months and request a far week (weekends)

Not in REQ today: members can only file for a week in phase `open` (REQ §4; the `upcoming` phase, §13.77, is materialized only for a multi-day series leg, invisible to members and closed to ordinary requests; a series may reach 6 weeks out). Needs a REQ §13 item first.
- **Screen:** entry in the siddur context (kebab) menu → "תכנון קדימה": a compact 2-month calendar (9 weeks, Sunday-first, Asia/Jerusalem) showing per day the number of requests already filed (all statuses except withdrawn/cancelled/denied) and, lightly, how many shared cars the department has that day; tapping a day opens the request form for that week/day.
- **Data:** one read RPC `planning_calendar(department_id, from_date, to_date)` (SECURITY DEFINER, `member_of`) returning `{day, requests, rides, shared_cars}` rows; no new table. Requests beyond the open horizon land in an `upcoming` week (reuse `ensure_upcoming_week()`), status `submitted`, editable/withdrawable like any open-week request, solved when the week reaches `open`→`solving` as usual. Members see `upcoming` weeks only through this calendar and their own request cards (the siddur/week switcher stays as is).
- **Q3 (horizon).** Two months ≈ 9 weeks. Raise the series ceiling (6 weeks, MDR01) to the same 9 so a weekend series can be filed from the calendar too?
  **A3.** Yes — the series ceiling follows the planning horizon (9 weeks).
- **Q4 (which days).** Owner text says weekends. Show counts for every day but allow far requests only Thu–Sat? Or allow any day (simpler, one rule)? I'd allow any day.
  **A4.** Any day; limiting the allowed days is an admin knob (department settings).
- **Q5 (what the count means).** Requests filed for that day, or *people* (requests + passengers)? And is it per department only (yes, I assume)?
  **A5.** Requests.
- **Q6 (priority).** Filing 8 weeks early is a submission-time advantage (`submissionTime` rule) — fine as intended ("less busy week wins"), or cap the rule so early birds don't always beat later-but-needier requests?
  **A6.** A policy decision: the submission-time rule gets params to cap the counted lead time on both ends (e.g. "only reward more than 7 days ahead", "nothing beyond N days").
- **Q7 (notifications).** No new event: the far request gets the normal `published`/`outcome_changed` when its week is published; the Sadran of that future week sees it on the board when the week opens. Confirm no "someone requested 6 weeks ahead" notice is wanted.
  **A7.** Confirmed, no new event.

### F7 — Feature (v1.2, **on hold**, owner 2026-09-15): multiple destinations on one request ("drop the kid at X, then drive to work at Y")

Not in REQ today: one destination per request (`requests.destination_id | destination_text`, REQ §5.1), and rides chain the *car's* location (`rides.origin_id/destination_id`, §13.57). Needs a REQ §13 item first.
- **Model:** `request_stops` (ordered stops per request, preset or free-text, optional minutes-at-stop), shown on the request card and the siddur as "X → Y". The request's existing `destination` stays the **final** destination (distance, zone, relay/car-location logic, mileage — all unchanged); stops are extra information plus matching input: joinable-rides / merge candidates (REQ §13.83) match against every stop's coordinates, so someone going to X can join. Templates (repeating requests) capture stops too. Excel export lists them.
- **Solver:** the trip stays one occupancy block (round trip, "car stays with me"); the solver does not route between stops in v1.2. One-way/passenger shapes: stops allowed only as information, no per-stop legs.
- **Q8 (scope).** Is "informational + matching" enough for v1.2, i.e. the solver treats the trip as one block to the final destination and never splits it at a stop? (Splitting would need per-stop legs in the timeline — much bigger.)
  **A8.** Yes — informational + matching; the solver keeps one block to the final destination.
- **Q9 (limits/return).** Cap at 3 stops? Do stops also apply on the way back (pick the kid up), i.e. separate outbound/return stop lists, or one ordered list marked "on the way there / on the way back"?
  **A9.** One ordered list, no cap, a tiny "add stop" button. No separate return list.

## Owner dump 2026-09-15 (13:38–14:54) — triaged 2026-09-15, owner answered Q1–Q9 the same afternoon — **building 2026-09-15**; D5 parked by the owner ("backburner") until the toast text is available

Order once approved: D1 → D6 → D5 → D4 → D3 (bugs, smallest first) → D2 (a REQ change: the one-way car-mode model). Every hypothesis below is marked as such — none has been reproduced yet.

### ~~D1~~ ✅ done 2026-09-15 — Bug: the default page must be the same for a Sadran and for a member (REQ §13.87: `/` and a fresh sign-in open the last opened main page — siddur or my rides — siddur by default; `src/app/landing.ts`, `LandingRedirect`, remembered per device)

- What the code says today: `/` redirects everyone to `/my` (`router.tsx`); the only role difference in the shell is the extra **סדרן** tab (`AppShell.tsx`), and `guards.tsx` only redirects non-Sadranim *away* from `/sadran/*`. So the difference the owner sees is not an explicit role branch — candidates: Home's week choice (`home_week_preference`, `homeWeek.ts`), the PWA start URL, or a remembered last route.
- **Q1.** What did you land on as Sadran vs as a member (which screen / which week), and after which action (fresh open, sign-in, tapping the app icon)?
  **A1.** Everyone — members, Sadranim, admins — lands on the *main* screen. Best: the last opened of the two main pages (siddur / my rides), because most people just want to see which car is available.

### ~~D6~~ ✅ done 2026-09-16 — Bug: dragging one leg back to the unmet lane shows the request twice (server: only that leg's request goes to the unmet list, the chain heals with an automatic relocation ride — REQ §13.89, `20260915110000_car_chain_relocation_rides.sql`; client: board refetches rides + car locations after unassign/cancel/edit) (on the remaining ride and in the unmet list)

- Hypothesis: the unmet lane calls `unassign_ride(ride)` (`20260907093500`), which cancels *that leg's* ride and sets the request `waitlisted` only when no other live ride serves it. With a two-leg (relay/passenger) assignment the other leg's ride survives, the request stays `assigned`, and the board lists it both on that ride and in the unmet list as an *incomplete assignment* (REQ §13.75 `incompleteAssignments`) — correct data, confusing display.
- **Q9.** Expected: dragging either leg to the unmet lane unassigns the **whole request** (both legs, one card in the unmet list), or only that leg, with the request shown once and marked "חסרה רגל" instead of appearing on the ride too?
  **A9.** Only that leg's card goes to the unmet list. The *other* leg's ride turns into a one-way ride with **"missing driver"** (the car is left away; see D4).

### D5 — Bug: a proposal about one leg — accepting changes nothing, and a toast shows "missing id … <hash>"

- Hypothesis: `maybe_apply_accepted_proposal` (`20260907092000`) applies a `shift` through `edit_ride` on the request's ride, and a `merge` by inserting `ride_requests(ride_id …)` from the proposal payload. For a request served by two leg rides it picks one ride (or a leg whose ride was since cancelled), so the insert fails on the `ride_requests.ride_id` foreign key and the raw Postgres detail — "Key (ride_id)=(<uuid>) is not present" — reaches the toast unmapped. The proposal then stays `accepted`, never `applied`.
- **Q8.** Paste the exact toast text, and say which proposal kind it was (הזזה / הצטרפות / other) and which leg (הלוך / חזור).
  **A8.** Not available now (it happened right after the double-card episode). Parked on the backburner.

### ~~D4~~ ✅ done 2026-09-16 — Bug: once two one-way rides exist you cannot change either (root cause was not a stale version but `assert_car_chain` refusing any state that leaves the car away: `car_away_at_day_end`; it now heals with a missing-driver relocation ride instead, reusing the removed leg's original times — REQ §13.89; `supabase/tests/car_chain_relocation.sql`) — every edit fails with "מישהו אחר שינה את זה" — and a one-way ride without its return leg should become "missing driver"

- Hypothesis: editing leg A (`edit_ride` → `assert_car_chain`) also rewrites leg B's row (car chain / location), so `bump_version` raises B's version while the open ride sheet still holds the old one; the board's query is not refreshed between the two edits, so the next edit on B (and, symmetrically, on A) is refused as stale. Needs a reproduction with two relay legs on one car.
- Owner rule to encode (REQ §5.4 addition): **a relay out-leg with no return leg is not a complete plan** — the car would be stranded at the destination. Removing/cancelling the return leg turns it into a **missing-driver return ride** (`needs_driver`, `one_way_from` the out-leg's destination, so a volunteer can take it) instead of leaving the car "free" there; a return leg must always start where the previous leg left the car (already REQ §13.58 "same destination", now enforced when editing too).
- **Q6.** When the *out* leg is removed instead, the return leg has no car at the destination — cancel it, or keep it as a missing-driver ride too?
  **A6.** Keep it as a missing-driver ride; when someone returns the car (volunteers / is paired) it automatically becomes an ordinary one-way leg.
- **Q7.** What time window does the auto-created missing-driver return ride get — the removed leg's original times, or "until `day_end_time`" (23:59) as the latest the car must be home?
  **A7.** The original times.

### ~~D3~~ ✅ done 2026-09-16 — Bug: a car taken out in the morning and returned by someone else in the evening must never look vacant in between (board grid shows an "away" band between the legs; the automatic return relocation ride shows as missing-driver; REQ §13.89)

- The model already has "away" windows: `freeWindows.awayWindows` (quick requests / car-now), the board's location badge (`geometry.ts awayByCarId`), and the solver's `carsAway`. Something still shows the car as free — to check after Q5: the siddur/board grid's empty space (no block drawn while the car sits at the destination), `try_auto_approve()` for a round trip filed against the published/live week (does it check car *location*, or only time overlap?), and the joinable-rides / waiting-list placement.
- Proposal: draw an explicit "away" block on the grid ("הרכב בבנימינה", non-interactive) for the whole gap between the out-leg and the return leg, and make every SQL placement path (`try_auto_approve`, `resolve_waitlist_group`, `enter_waiting_list`) refuse a keep ride that starts at home while the car is away.
- **Q5.** Where did you see it as vacant — siddur grid, board grid, car-now button, or a request that actually got auto-approved onto the away car?
  **A5.** On the Sadran board.

### ~~D2~~ ✅ done 2026-09-16 — Change (REQ §13.88): no "הרכב נשאר איתי" vs "צריך הסעה" choice on one-way rides (`profiles.does_not_drive` + profile switch + admin editor; `submit_request` defaults the mode; solver `Request.canDrive`, `PLACED_NEEDS_DRIVER`/`PLACED_RELAY_SOLO`; `non_driver_cannot_drive` guard in `assert_ride_driver`) — everyone can drive unless they say otherwise

- Today a one-way request carries `one_way_car_mode` (`relay` — I drive and leave the car there / `passenger` — I need a lift), chosen by the member. Owner rule: drop the question; assume every member can drive, and let members who do not drive say so **once, in their profile** (new `profiles.does_not_drive`, admin-editable too). The solver then decides per leg: `relay` when a car can go/come back (pairing legs to the same destination), else `passenger` in a ride going the same way, else `chauffeur` — exactly today's fallback chain, just without the member's preference. A non-driver is never placed as driver/relay (solver `Request.canDrive`, `assert`ed in `apply_solver_result`/`edit_ride`), and never gets the volunteer "missing driver" prompts.
- Scope: REQ §5.1 row + §5.4 + new §13 item; migration (profile flag, `submit_request` accepts a missing mode and defaults it, `one_way_car_mode` stays in the schema as the solver's decision); request form loses the control (and `templates` capture); solver reads `canDrive`; profile screen switch "אני לא נוהג/ת"; admin member editor; docs/tests.
- **Q2.** Keep the stored `one_way_car_mode` as the *solver's* decision (visible to the Sadran on the board) — yes?
  **A2.** Everyone should still *see* whether a car is driven somewhere to stay there or it is a short ride with another driver — the mode stays visible as the outcome, the member just does not choose it. Rule: "I asked to get to X with a car and nobody can take it back" ⇒ effectively a one-way (relay, car stays at X). "I asked one-way but someone can return it" ⇒ unless I am a non-driver, a two-leg ride (I drive out, someone drives it back).
- **Q3.** The non-driver flag: member self-service in the profile *and* admin-editable, default "drives"?
  **A3.** Yes.
- **Q4.** Does it apply to round trips too — a non-driver's round trip is forced to "car not needed at destination" (served as passenger/chauffeur legs), and the Sadran sees why?
  **A4.** Yes. A non-driver who asks for a car gets one **without a driver** (they may bring their own guest driver) or is assigned to other people's rides.

## Owner notes 2026-09-16 (morning) — code freeze for the current version: bugs only, features parked

### N1 — Bug: notification day reads "ה׳ 16.9"; it should read "יום ה׳ 16.9"

- The `{{day}}` var is "ה׳ 16.9" (B4). In running text that needs the word "יום": "ביום ה׳ 16.9", "יום ה׳ 16.9 08:00–12:00". Fix in the **templates** (the Hebrew place), not in SQL logic: every seeded template that renders `{{day}}` gets the prefix (`ב{{day}}` → `ביום {{day}}`, bare `{{day}}` → `יום {{day}}`; `ביום/ליום {{day}}` already right), in `supabase/seed.sql` and, for production, a migration that rewrites only rows the admin never edited (`body = default_body`). The UI keeps "ה׳ 16.9" on cards (owner's format choice A1 of 2026-09-15). **Built 2026-09-16**, `20260915130000_notification_day_prefix_and_proposal_link.sql`.

### N3 — Bug: a sent notification shows the literal `{{link}}`

- Root cause: the proposal composer stores the whole WhatsApp text — including the `{{link}}` token it deliberately leaves unrendered until send time — as `proposals.reason_he`; `notification_context()` exposes that as `{{proposalShort}}`, and the inbox/push `proposal_received` template prints it verbatim. Fix: `notification_context()` renders `reason_he` with `link` = the notification's own deep link (`_data.url`, computed by `notification_default_url()` before the context is built) — so the inbox text carries a working link and never a raw token. **Built 2026-09-16**, same migration as N1.

### N4 — Bug (parked with D5; one likely cause fixed 2026-09-16): the "hashed" toast, now seen when re-solving the week after manual request changes

- **Found and fixed one concrete instance (2026-09-16, `20260915140000`):** `apply_solver_result` cast the payload's `driver_id` straight to uuid and the client sent `""` for a driverless ride, so a re-solve that produced any driverless placement failed with "invalid input syntax for type uuid" (a 400 whose detail line reads like a hash); the deferred `rides_location_ends` trigger also rejected the solver's relocation ride at commit. Both fixed; `e2e/board.spec.ts` "bug #4" now prints the response body on failure. The proposal-apply variant (D5) is still unreproduced.
- Same family as D5. Nothing in the local Postgres log for it (PostgREST-side errors are not logged at the default level). Hypothesis: `apply_solver_result` in full mode deletes unpinned rides and re-inserts the solver's output; a solver `hostRideId`/leg `ride_id` that points at a ride deleted in that same run fails the `ride_requests.ride_id` foreign key, and the toast's "unknown error" fallback shows the Postgres detail "Key (ride_id)=(<uuid>) is not present". Next time: copy the toast's small grey description line (it is the Postgres detail) — that names the table and column. Not touched under the freeze.

### N2 — Feature (parked, code freeze): לשון פנייה (form of address) in the profile

- Would add `profiles.address_form` (e.g. `neutral | masculine | feminine`, default neutral = today's slash forms) and gendered variants of every template and UI string that addresses the member (נהג/ת, אישר/ה, שובצת …). Notification templates would need a variant per form (or a `{{gender:נהג|נהגת}}` mini-syntax in `render_notification_text`), and the UI dictionary a parallel set — a copy-wide change. **Reverses consistency decision 20 / REQ §13.49** ("slash forms only, no per-member gender field — final"), so it needs an explicit owner decision in REQ first. Estimate: medium-large; not for this version.

## Owner notes 2026-09-16 (afternoon) — triaged 2026-09-16, owner answered Q1–Q4 — **building 2026-09-16** (REQ §13.88 made precise, §13.90, §13.91)

### ~~E1~~ ✅ done 2026-09-16 — One-way legs: relay pair whenever a returner exists, chauffeur ride otherwise (REQ §13.88 precise; `20260916100000_car_chain_one_way_healing.sql`, solver `chauffeurUnpairedRelayLegs`; `car_chain_healing.sql`)

- **Rule (owner, restated):** there is no difference between "I take the car one way" and "someone takes me one way". A one-way request means "I need to get to X" / "back from X". If my leg (A → X) and someone else's leg (X → home) are **both at X**, and each leg has at least one eligible driver (`does_not_drive = false`) on board, **both** rides are ordinary "leaves the car" relay legs — the car is reserved at X for the time between, nobody is "missing driver". Only when no matching leg exists does the lone leg get the automatic missing-driver return (REQ §13.89). Removing one leg of such a pair turns the other into missing-driver; adding a matching leg later turns it back.
- What still contradicts it in the code: the solver *honours a stored legacy* `one_way_car_mode = 'passenger'` (`resolveOneWayMode`, `src/solver/slots.ts`) — requests filed before 2026-09-16 or by the quick one-way ("someone takes me") therefore still become chauffeur / missing-driver rides even for a driver; `submit_request`'s quick one-way reservation (`reserve_missing_driver`) still insists on `passenger` and books a missing-driver ride. Fix: the stored member preference is ignored for drivers everywhere (solver `resolveOneWayMode` → `canDrive ? relay : passenger`, no exceptions; a data migration flips existing non-cancelled one-way requests of drivers to `relay`); pairing checks the *people on board*, not the requester alone (a non-driver requester whose companion drives still makes a relay leg — solver: eligible driver among requester/companions); the quick one-way reservation for a driver becomes a relay ride (car stays at X, automatic return relocation) instead of a chauffeur ride. Board/siddur wording for a relocation stays "החזרת רכב — חסר/ה נהג/ת".
- **Q1.** The quick one-way from an empty slot in the live week ("someone takes me now"): for a driver it becomes "I drive the car there and it waits for a returner" — confirm that is what you want there too (today it books a chauffeur ride).
  **A1.** Yes — but ONLY if I can drive there AND someone else can drive back do both rides become "I drive". If nobody can drive back, my leg is a **chauffeur** ride. Leg 1 removed → leg 2 becomes chauffeur, and vice versa; a returner appearing → BOTH become "I drive one way".
- **Q2.** "One of the passengers is an eligible driver": when the requester is a non-driver but a named companion can drive, may the system make that companion the leg's driver automatically, or should it only do so on the Sadran's board (not on auto-approve)?
  **A2.** Yes — a driving companion becomes the driver automatically.

### ~~E2~~ ✅ done 2026-09-16 — Bug (production): re-solve fails with `key (id)=<uuid> is still referenced from table "proposals"`; withdrawing a request settles its proposals (REQ §13.90; `20260916110000_withdraw_settles_proposals.sql`; `withdraw_settles.sql`)

- Root cause: `apply_solver_result` in full mode deletes every unpinned ride, but `proposals.ride_id` / `proposals.applied_ride_id` reference rides with a plain FK (no `on delete`), so a week with any proposal about a re-solvable ride cannot be re-solved. The toast shows the raw Postgres detail (this is the "hashed toast").
- Fix: (a) `apply_solver_result` first withdraws pending (`draft`/`sent`) proposals whose host ride it is about to delete (restore the request's previous status, revoke tokens — reuse the existing withdraw path) and detaches historical ones (`ride_id`/`applied_ride_id → null`, kept for the audit trail); (b) **`withdraw_request` withdraws every pending proposal of that request and every pending proposal in which the request is a party** (a merge offered to a host about this passenger), restoring the other parties' statuses; (c) after a withdrawal in a published/live week, the vacancy is re-offered: an assigned request's ride cancels through the existing freed-slot flow (auto-assigns a lone waitlisted candidate, REQ §13.66); a **waitlisted** withdrawal inside a contested group leaves the group to be re-evaluated — a group with one remaining member auto-resolves onto the car it was contesting (REQ §13.75 extension).
- **Q3.** Auto-resolving a contested group down to one remaining member: assign immediately (they get `waitlist_resolved` + the car), or notify the Sadran and leave it for them? I'd assign immediately — that is what "you should get the car if otherwise applicable" says.
  **A3.** Assign immediately.

### ~~E3~~ ✅ done 2026-09-16 — Bug: two different "my rides" screens; one summary screen with safe actions (REQ §13.91; `/my` lists every upcoming week, `/requests` redirects, `/my/history` lazy)

- Today: after a submit the form navigates to `/requests` (`RequestsListPage`: edit / withdraw / cancel / repeat, with confirm dialogs), while the bottom tab "הבקשות שלי" opens `/my` (`HomePage`: next action, upcoming rides, unserved requests, the week's list). Owner: **one** screen — the summary (`/my`) — from which I can cancel/withdraw/edit with a confirmation popup, showing only what lies ahead (a request whose day has passed is not shown; it is history, not a to-do).
- Plan: `/my` gets the row actions of `RequestsListPage` (withdraw / cancel ride / edit / repeat-weekly, each behind `ConfirmDialog`, never a bare tap); the form and every "הבקשות שלי" link navigate to `/my`; `/requests` redirects to `/my` (deep links keep working: `/requests?focus=<id>` → `/my?focus=<id>`, `/requests/new` and `/requests/:id/edit` unchanged); requests/rides whose day is before today (Asia/Jerusalem) are hidden on `/my` for every week; the week's request list on Home is the only list. UX_FLOWS §3.3 rewritten, REQ §5.5 one sentence, `RequestsListPage.tsx` deleted (its tests moved to Home's).
- **Q4.** Where should past requests remain reachable — nowhere in the app (the siddur archive shows past weeks' rides already), or a small "היסטוריה" link at the bottom of `/my`?
  **A4.** A "היסטוריה" link, lazily loaded (not important, must not slow anything).

## Owner request 2026-09-24 — v1.0 feature: swap cars on a published day (triaged; owner answered Q1–Q7 the same day — **building 2026-09-24**, REQ §13.92)

### ~~S1~~ ✅ done 2026-09-24 — Drag a car name onto another car name to swap the two cars' rides for that day (REQ §13.92; `preview_day_car_swap`/`swap_day_cars`, `car_swapped` event, `CarSwapDialog`, `day_car_swap.sql`, `e2e/car-swap.spec.ts`)

- Owner: on the Sadran board and on the member siddur grid, drag car X's header onto car Y's header → all of X's rides that day move to Y and vice versa. Any member may do it on a published day that has not passed; everyone affected is notified. Refused when it would break a restriction (today: multi-day series rides).
- Sketch: one RPC `swap_day_cars(dept, week, day, car_a, car_b, expected_versions)` (SECURITY DEFINER, member of the department, day published or managed by a Sadran, not archived/past) that swaps `car_id` on both cars' non-cancelled rides of that day in one transaction, re-checks everything the ride writers check (turnaround, maintenance blocks, seat configurations, temporary-car rules, `assert_car_chain`), bumps versions, audits, and notifies. Grid: car headers become drag sources/targets (`WeekGrid`, both screens) with a `ConfirmDialog` listing what moves. REQ §13 item, UX_FLOWS §3.5/§4.2, DATA_MODEL, SQL suite, Playwright spec.
- **Q1.** Scope is one **day** (the day selected on the grid), both cars' rides that day — not the whole week. Correct?
  **A1.** Per day — except a multi-day ride on that day: ask whether to swap its **whole span** (all its days) or **only this day**; "only this day" splits the series into up to three: the days before (still car A, renumbered 1/2, 2/2), this day (car B), the days after (car A).
- **Q2.** Dragging onto a car with **no rides** that day = move all of X's rides to Y (a one-way "swap"). Allowed?
  **A2.** Yes.
- **Q3.** A day already in progress (today, some rides already started/ended): swap only the rides that have not started yet, or refuse the swap for today once any ride on either car has started?
  **A3.** Swap the whole day, started rides included (typical use: someone took the wrong car).
- **Q4.** Other restrictions besides multi-day series — refuse the swap when: a ride no longer fits the other car's seats/luggage; the target car has a maintenance block then; a **temporary (private) car** is involved (only its owner drives it); the car is away from home that day (a relay pair leaves it at X — swapping moves "the car at X" too). I'd refuse in all four cases with a clear message. OK?
  **A4.** Refuse on seats/luggage and maintenance, with a clear message naming the ride. Private car: refused, UNLESS the owner does the swap (they may lend their car while taking a bigger one). A car ending the day away from home is NOT a blocker — show a notice after the swap ("שים/י לב: רכב B מסיים את היום ב-X").
- **Q5.** Notifications: reuse the existing `outcome_changed` event ("שינוי בסידור שלך…", diff line "רכב: X → Y"), sent to every driver and passenger on the moved rides (not to the person who swapped), or a new dedicated event "הרכב שלך לנסיעה ביום … הוחלף ל־Y" (new enum value, own mute toggle)? I'd add the dedicated event — it reads clearer and members may want to mute it separately.
  **A5.** Dedicated event.
- **Q6.** Unpublished days on the Sadran board: allow the same drag there too (Sadran only, no notifications — it is planning)?
  **A6.** Yes, unpublished days on the board: Sadran only, no notifications.
- **Q7.** Should the swapper be able to undo it (e.g. a toast "בוטל" button for a few seconds that swaps back and sends a follow-up "cancelled" notice), or is the confirmation dialog enough?
  **A7.** Confirmation is enough; no undo. (Future, not this version: debounce/merge queued notifications.)

## Code review 2026-09-24 — follow-ups (triaged; owner answered Q1–Q4 the same day — **built 2026-09-24**; new owner questions Q5–Q8 at the end)

Scope set by the owner: level 1 (bugs), level 2 (refactors of existing behaviour), new tests, and a column checklist for tables readable across departments. **Out of scope:** notification merging/digest (owner: not yet shown to be a real problem). E2E baseline: `e95bfd1` passes all 67 specs on a clean tree; the 6 failures seen on 2026-09-24 came from files changing mid-run (see R5). Dropped from the review: "carCare/stats/proposals skip `toAppError`" — false, they go through the `rpc()` wrapper.

### Level 1 — bugs

#### ~~R1~~ ✅ done 2026-09-24 — Bug (department separation): `apply_solver_result` can rewrite another department's request statuses
- The live function's `request_statuses` loop runs `update public.requests … where id = <payload id>` with no department/week filter; `can_manage_week(p_department_id, p_week_start)` is checked once at the top only, and `requests_status_guard()` only restricts the requester. A Sadran of department A calling the RPC directly can set department B's requests to `denied`/`cancelled`. Rides are safe (`rides_car_same_department`, `ride_requests_dept_week_match`).
- Fix: add `and department_id = p_department_id and week_start = p_week_start` (new migration, full `create or replace`, see R10); regression assertion in the R12 suite.
- Done: `20260924110000_apply_solver_result_department_scope.sql` (an out-of-scope id is ignored and never reported as unassigned).

#### ~~R2~~ ✅ done 2026-09-24 (via R6) — Bug: members cannot mute waiting-list notifications
- UX_FLOWS §6.1 puts `waitlist_contested`/`waitlist_resolved` in the "מקומות שמתפנים" mute category; `src/features/inbox/muteCategories.ts` omits them. Fix via R6 (or directly if R6 is not approved) + unit test.

#### ~~R3~~ ✅ done 2026-09-24 (via R6) — Bug: inbox filter tabs misfile newer events
- `src/pages/InboxPage.tsx` hard-codes the tab sets: `window_changed` is missing from the siddur tab, `waitlist_*` fall into "system" instead of freed slots; `car_swapped` (S1) will need a home too. Fix via R6.

#### ~~R4~~ ✅ no change 2026-09-24 — approving/editing a member refetches every query in the app
- `src/features/admin/members/hooks.ts` `useInvalidateMembers` calls `invalidateQueries()` with no key. Replace with the member/department keys actually affected.
- Resolution: deliberate (commit de0321b, "display names and department isolation") — a member's name/role/membership shows on nearly every screen, admin actions are rare, only mounted queries refetch. Kept; explained in a comment.

#### ~~R5~~ ✅ done 2026-09-24 — Tooling: e2e runs against the live working tree
- Any concurrent edit (another agent, the owner) breaks page loads mid-run, and `board.spec.ts`'s mid-suite `db:reset` applies whatever half-written migrations are on disk. Add `npm run e2e:isolated`: `git archive HEAD` into a temp dir, symlink `node_modules`, own Vite port, `E2E_SUPABASE_WORKDIR` pointing there (both resets then replay committed migrations only). Document in CLAUDE.md commands + MAINTENANCE.
- Done: `scripts/e2e-isolated.mjs` — default snapshots the working tree (tracked + untracked, not ignored) so uncommitted work is tested but later edits are not; `--head` = committed code only; `--keep` keeps the snapshot.

### Level 2 — refactors (no behaviour change beyond R2/R3)

#### ~~R6~~ ✅ done 2026-09-24 — One metadata source per notification event (`20260924110200_notification_event_meta.sql`, `src/lib/notificationEvents.ts`)
- Today "which events are special" is hard-coded in five places: the Sadran mute-bypass and never-mutable lists in `enqueue_notification()`, the week-scoped branch of `notification_default_url()`, `muteCategories.ts`, the `InboxPage` tab sets.
- Plan: SQL table `notification_event_meta(event pk, category, member_mutable, sadran_role, week_scoped)` read by both SQL functions; TS mirror `src/lib/notificationEvents.ts` typed `Record<NotificationEvent, Meta>` (a missing event fails typecheck) driving the mute list and inbox tabs; a SQL suite assertion that every enum value has a meta row; parity TS↔SQL added to `/review-consistency`. `/add-notification-event` skill updated to one place. No enum values merged or removed.

#### ~~R7~~ ✅ done 2026-09-24 — Scoped cache invalidation (`features/rides/invalidateWeek.ts` `invalidateWeekData()`: that week's board, every siddur query except other weeks' rides, all requests keys — the requests keys are per-user anyway, so scoping them only risked stale `byId`/`companions`/`freedOffers`)
- ~21 mutation `onSuccess` sites invalidate whole feature caches (`siddurKeys.all`, `requestsKeys.all`, e.g. `invalidateBoard` in `sadran/hooks.ts`). Replace with the `(department, week)` keys where the mutation is week-bound; keep `.all` only for genuinely cross-week mutations (series, admin catalogs). Verify each key factory carries dept/week first.

#### ~~R8~~ ✅ done 2026-09-24 — Break the siddur ⇄ sadran import cycle (`src/features/rides/`, `src/lib/xlsx.ts`, ESLint boundary)
- Each imports the other's internals (`ridePeople`, `servedOf`, `AddPassengersDialog`, `RidePassengersList`, `RidePublicNotesEditor`, `ensureDepartmentWeeks`, `sadranKeys`). Move the shared pieces to a neutral `src/features/rides/`; add an ESLint `no-restricted-imports` boundary so the cycle cannot come back; update the CLAUDE.md folder map.

#### R9 — Split the two largest components (pure moves)
- `BoardScreen.tsx` (1,579 lines) → container + `useBoardData`/`useBoardDnd` hooks + extracted dialogs; `RequestForm.tsx` (1,224 lines) → field-group subcomponents with narrow props. Gate: board + request-form Playwright specs. Done last (touches the same files as S1 and R8).

#### ~~R10~~ ✅ done 2026-09-24 — The current SQL readable in one place (`npm run db:schema` → `supabase/schema-current.sql`, CI freshness diff with the CLI pinned to package.json's version)
- Key functions are redefined many times (`submit_request` 8×, `v_board_rides` 11×) and recent migrations patch functions by string replace on `pg_get_functiondef`, so the current definition exists only in a running database. Add a generated, committed `supabase/schema-current.sql` (`npm run db:schema`, schema-only dump after `db:reset`), CI diff-checks it like `types.ts`. Convention from now on: a migration that changes a function writes the full `create or replace` (committed migrations are never edited).

#### ~~R11~~ ✅ done 2026-09-24 — One-way pairing is implemented twice (`supabase/tests/fixtures/one_way_pairing_cases.json`, 10 cases; it found a real SQL bug, fixed in `20260924110400_pair_one_way_legs_cross_car_exclusion.sql` — two legs on different cars never paired; 4 remaining design differences → Q5–Q8)
- SQL `pair_one_way_legs()`/`try_widen_one_way_leg()` inside `assert_car_chain` and the solver's relay/chauffeur logic decide the same thing independently. Shared golden cases (one JSON file) run by a Vitest test against the solver and by a node-driven `db:test` step against SQL, so the two cannot drift silently.

### New tests

#### ~~R12~~ ✅ done 2026-09-24 — Department isolation suite (`supabase/tests/department_isolation.sql`)
- Two departments; as a Sadran/member of A, call every browser-facing SECURITY DEFINER RPC with B's ids (requests, rides, cars, members, children, groups, proposals) — each must raise or change nothing. The list of RPCs is checked against the functions granted to `authenticated` (like `rls_smoke.sql` TEST 14), so a new RPC fails the suite until it is covered.
- Plus a guard trigger on `requests`: a status change must come from the requester's own allowed transitions, `can_manage_week(new.department_id, new.week_start)`, or the `app.system_status_transition` flag — the table-level twin of the rides triggers, so a future RPC that forgets the filter is still caught.

#### ~~R13~~ ✅ done 2026-09-24 — Unit tests for untested load-bearing features (auth guards + `useActiveDepartment`, fleet api/keys: 47 tests; inbox mute/tab mapping with R6)
- `features/auth` (guards; `useActiveDepartment` fallback chain route → per-user localStorage → profile default → first membership), `features/fleet` (api row mapping, hooks keys), `features/inbox` (every mutable event is in a mute category, tab mapping, deep links). `docs/TEST_MAP.md` + `test-map.json` updated.

### Column checklist

#### ~~R14~~ ✅ done 2026-09-24 — Pin the columns of tables readable across departments (`rls_smoke.sql` TEST 18, DATA_MODEL §4.4)
- Live SELECT policies that only check `is_approved()`: `app_settings`, `car_seat_configs`, `cars`, `departments`, `notification_templates`, `profiles` (column grants), `ride_types`, `weekday_labels`. New `rls_smoke.sql` test: each such table's column list (and `profiles`' granted columns) is pinned with a classification; a new column fails `db:test` until it is classified "public across departments" or moved to a department-scoped table (precedent: `car_access_codes`). Checklist paragraph in DATA_MODEL §4 and a step in the `/add-migration` skill.
- Found while listing: `profiles` exposes `email`, `is_admin`, `approval_status` and `muted_events` to every approved member of every department (see Q2).

### Questions

- **Q1.** R12 ("cross-department injection") is not classic SQL injection — it means calling an RPC with ids that belong to another department. It is the test that *proves* department separation, and R1 is exactly what it would have caught. Include R12 + the `requests` guard trigger? I'd include both.
  **A1.** Yes — R12 and the `requests` guard trigger are in scope.
- **Q2.** `profiles`: restrict `email` (and `muted_events`, `approval_status`) to the member themselves, their departments' Sadranim and admins, keeping name/avatar/`does_not_drive` public across departments? Needs a check of which screens read other members' email first.
  **A2.** No change. `email` and `is_admin` are needed across departments; `approval_status` and `muted_events` do not matter. R14 classifies all four as "public across departments".
- **Q3.** R10: OK to add the generated `schema-current.sql` + CI check and the "full `create or replace`" convention?
  **A3.** Yes. Update the deployment docs (`FREE_DEPLOYMENT.md`, `RUNBOOK_ROLLBACK.md`, `scripts/release.mjs` notes) where the new file or CI check affects them.
- **Q4.** R11 is the largest item (new cross-language test harness). Include now, or park it after the rest?
  **A4.** Include now — it is a vital test.

#### Found while building (2026-09-24)
- The stricter `requests` guard (R12) broke a signed-in **second party declining a proposal** (`not_authorized`) — caught in review before any e2e run, fixed in `20260924110300_proposals_status_guard_system_transition.sql` with a regression test.
- Follow-ups, not done: 7 RPCs are classified "inspected" rather than live-tested in `department_isolation.sql` (`move_series`, `swap_day_cars`, `preview_day_car_swap`, `report_car_issue_unsafe_to_maintenance`, `approve_claim`, `close_offer`, `claim_ride_driver`); `registerTemporaryCar` (member temporary car) can leave a car without a seat configuration if the second insert fails; SQL pairing reaches its final state only after repeated `assert_car_chain` calls in a cross-day case (the final answer is right, the intermediate state is call-order-dependent).

#### New questions (from R11 — the solver and the SQL healing decide one-way pairing differently)
- **Q5.** Two opposite one-way legs whose gap at X is **shorter than the turnaround** (default 30 min): SQL leaves both as separate chauffeur rides; the solver pairs them, then cannot place the pair, so **both stay unmet**. I'd make the solver behave like SQL (no pair → each leg gets its chauffeur ride). OK?
  **A5.** No — let the pair go through when the gap is short (only an actual overlap prevents pairing). Built 2026-09-24: REQUIREMENTS §13.88 "Compatible times", `20260924120000_relay_pair_short_gap.sql`, solver `relayPairId` buffer exemption + `Assignment.turnaroundAfterMinutes`. This also resolves Q6 (the solver's shift-to-pair lands at 0 minutes at X, which now pairs); the remaining shift difference is by design — SQL healing never shifts a member's own times.
- **Q6.** Solver bug: when the solver shifts two overlapping legs within their flexibility to pair them, it shifts by exactly the overlap, leaving 0 minutes at X — which the turnaround buffer then always rejects, so a shift-to-pair can never succeed. I'd shift by overlap + turnaround (still within each leg's flexibility). OK?
- **Q7.** A one-way leg with **no eligible driver** (a non-driver alone): SQL creates a missing-driver chauffeur ride (REQ §13.88); the solver leaves the request unmet with no ride. I'd have the solver create the same missing-driver ride. OK?
  **A7.** Yes. Built 2026-09-24: `solve()` places such a leg as a missing-driver chauffeur ride (`PLACED_NEEDS_DRIVER`); unmet only when no car has room.
- **Q8.** When SQL consolidates two legs onto one car it does **not** check seats/luggage (the solver does). I'd add the seat check and keep the separate chauffeur rides when the car is too small. OK?
  **A8.** Yes. Built 2026-09-24 in `20260924120000_relay_pair_short_gap.sql` (`car_fits()` for both legs on the target car). Found while testing Q5–Q8: `pair_one_way_legs()` forced `app.system_status_transition` off, breaking a caller that still had status writes (`reserve_live_one_way_slot`); now restored, and a quick reservation that pairs reports `assigned`/`RELAY_PAIRED`.

## Owner request 2026-10-04 — origins, three trip types, cars stay where they are left (required before real usage; owner answered every question the same day — **building**, REQ §13.93)

Decisions (full text in REQ §13.93): explicit request origin (list place or free text; default per member per department, set by the member, admin may set it too); three trip types **הלוך-חזור / הלוך בלבד / הקפצה** replace round trip / one way / one way back; a car stays wherever its last ride left it (no day-end rule, no relocation rides, no overnight acknowledgement); optional base location per car; a gap means "free at base" unless marked away; an away car is bookable only from where it is; הקפצה = pair (same day only) / volunteer driver (only when one end is where the car is) / passenger; הלוך בלבד placed automatically only when it breaks no later ride; week-end-away and broken-chain board warnings; week starts from the previous week's planned end locations; distance/travel time per pair (straight-line estimate, replaced by a Google route); merging only with the same origin; "car now" = cars at the department home; the "car from Y" suggestion is Sadran-only until sent as a proposal; existing data → origin = home, one-way → הקפצה.

### ~~O1~~ ✅ done 2026-10-04 — Requirements and design (REQ §13.93; DATA_MODEL / SOLVER / UX_FLOWS follow with each step)
### ~~O2~~ ✅ done 2026-10-04 — Schema: request/template origin, trip type, default origin per membership, car base location, per-pair distances; backfill existing data
### ~~O3~~ ✅ done 2026-10-04 — SQL car chain: location carries across days/weeks; healing kept only for הקפצה legs; relocation rides / overnight ack retired; pairing generalized to "any same-day trip leaving X"; shared pairing golden cases updated
### ~~O4~~ ✅ done 2026-10-04 (incl. O4b, the `origin` proposal end to end) — Solver: timelines follow the car's location across the week; placement only at the car's location; הלוך בלבד no-break rule; distance from origin; "car from Y" suggestion → new proposal type
### ~~O5~~ ✅ done 2026-10-04 — UI: request form "מ<origin> אל <יעד>" + three trip types; default origin in profile/admin member editor; car base in the car editor; origin → destination display; driver labels; board warnings (broken chain, away at week end); car-now from home only; quick request origin from the car's location
### ~~O6~~ ✅ done 2026-10-05 — Multi-stop rides (second step): + stops, drop-off/pickup at a declared stop, merging at a declared stop

### Known limitations found while building (2026-10-04)
- SQL `pair_one_way_legs()` pairs one-leg הקפצה requests only; the two legs of a הקפצה **with** a pickup are paired with other members' legs only by a solver run (`splitLegs`), not by the SQL healing after a manual edit — unchanged from before §13.93.
- The "car from Y" (`changeOrigin`) suggestion is offered only for הלוך-חזור, הלוך בלבד and a הקפצה with a pickup — the trip types the `origin` proposal can place (SOLVER §3.11 item 4a).

### Follow-ups — done 2026-10-05
- ~~Notification copy shows the origin~~ — `{{route}}` ("ל<dest>" / "מ<origin> ל<dest>" / "… דרך <stops> …") from the seeded `text_fragments` table via `route_label()`; 28 templates switched; the browser-rendered WhatsApp templates use the TS twin `src/lib/routeLabel.ts`.
- ~~Relay-pair labels name the partner~~ — `v_board_rides.relay_partner` ("משאיר/ה את הרכב בחריש ליוסי (9:00)" / "הרכב מחכה לך בחריש — דנה מביאה אותו ב-8:40").

### Ideas for later (not scheduled)
- Undeclared "on the way" pickups/drop-offs: a trip Givat Haviva → Haifa may take route 6 or route 2, so "Binyamina is on the way" cannot be assumed; let people coordinate by hand for now (owner 2026-10-04).

## Owner feedback 2026-10-05 — after REQ §13.93 (triaged; owner answered Q1–Q5 the same day — **built 2026-10-05**, REQ §13.94; design `docs/BOARD_DRAFTS_PLAN_2026-10.md`)

### Bugs
- ~~**G1**~~ ✅ **Unreadable solver text on the board.** Unmet reasons and suggestions print raw ids: "אין רכב פנוי בחלון המבוקש; חוסמים: 00000000-…042", "יש רכב פנוי ב00000000-…010 … עם יונדאי 1". `reasons.ts` gets car/location ids as vars (`UNMET_NO_CAR` blockers, `SUGGEST_CHANGE_ORIGIN` origin, and any other id-valued var). Fix: render names (car names, place names passed into the solver input), and audit every reason template for id vars.
- ~~**G2**~~ ✅ **A הלוך בלבד is treated as needing a driver.** The quick sheet's one-way submit reads "הוסף/י הסעה שמחפשת נהג/ת" and the toast says a driver is still needed — the pre-§13.93 one-way copy; verify the weekly form/SQL path too (a הלוך בלבד from Givat Haviva to Haifa must be bookable as "I take the car").
- ~~**G3**~~ ✅ **The department home shows as "נבו".** "נבו" is the department's name; the home place must read as the department's location (גבעת חביבה). Seed: rename the home place; production (no data yet): the admin names the home place; make sure the home place's name is editable in the admin destinations screen.
- ~~**G4**~~ ✅ **A הקפצה with a pickup held the car for the whole window** (the solver's fallback to `keep` for a requester who can drive). Expected: two separate trips (drop-off, later pickup), the car free in between.
- ~~**G5**~~ ✅ **"ממתין לתשובתך" on "my rides":** long text must wrap or truncate; a proposal that was withdrawn/expired/answered must disappear from it.
- ~~**G6**~~ ✅ **The Sadran cannot see a request's origin and trip type** on the board (unmet cards, phantom lanes, request/ride sheets): show "מ<origin> ל<destination>" and the trip type (הלוך-חזור / הלוך בלבד / הקפצה) everywhere the Sadran looks at a request or ride.

### Features
- ~~**G7**~~ ✅ **Turnaround after arriving away from base.** Example: 08:00 Givat Haviva → Haifa (one-way, arrives ~08:45) and 08:00 Haifa → Afula (and back): moving the second to 09:00 on the same car was impossible. (Q1)
- ~~**G8**~~ ✅ **The Sadran edits a ride's details:** end location, stops (and origin?) from the ride sheet. (Q2)
- ~~**G9**~~ ✅ **Drafts on the board.** Every "make a suggestion" popup also offers "טיוטה": the change is applied on the board tentatively and the popup closes, no message is sent; the board can be shaped freely without asking anyone yet. Publishing is blocked until every draft is sent and answered, or discarded. (Q3)
- ~~**G10**~~ ✅ **Merging makes one ride, not two overlapping blocks.** The merged ride keeps the base ride's driver and final location; the other request's destination becomes a stop on it and its driver becomes a passenger; a popup asks whether the added person rides one-way or both ways; the merged ride looks normal (no red stripes, which read as an error) with a merged marker; dragging the added person out of it undoes the merge (removes the extra stop and passenger). (Q4, Q5)

### Answers (owner 2026-10-05)
- **Q1 (G7):** yes — the turnaround is waived at a handover away from the base, specifically for manual (Sadran) placements; automatic placement keeps the buffer.
- **Q2 (G8):** yes — editing a member's ride's places/stops goes through their consent (suggestion or draft); the Sadran's own reservations change directly.
- **Q3 (G9):** yes to all — Sadranim-only and saved; dashed "טיוטה"; auto-fill/re-solve keep drafts; send or discard; publishing refused while drafts remain.
- **Q4 (G10):** yes — the base ride's times; the added places inserted where they add the least driving with estimated times (a different start = a pickup stop); one way / both ways; the suggestion states a changed time; consent or draft.
- **Q5 (G10):** yes — the ride dropped onto is the base; the joiner's own booking is released; dragging them out restores their request.

### Found while testing (owner, 2026-10-05)
- ~~"לא ניתן לטעון את ההצעה כרגע" when a member opens a suggestion~~ — environment, not code: since 2026-09-24 the local stack's edge-runtime container was mounted on a deleted `e2e:isolated` snapshot (Playwright's webServer had started `supabase functions serve` from the snapshot), so every edge function failed ("failed to determine entrypoint"). Fixed by restarting the stack (data kept; backup in `backups/*-2026-10-05_1357.sql`); `scripts/e2e-isolated.mjs` now restarts the stack from the repository after a run whenever the edge runtime is mounted on its snapshot.
- ~~Board warning "הרכב לא נמצא כאן — הוא בחיפה" named the ride's own start instead of where the car is~~ — `ChainBreak` fields renamed to `carLocationId` (where the car is) / `rideOriginId` (where the ride starts); the board names `carLocationId`.
- The home place still reads "נבו" on an existing local database: the seed rename only applies on a reset — rename it in ניהול מערכת → יעדים (the `home` row).

## Owner feedback 2026-10-05 (evening) — merge detours, connected legs, trip-type changes (owner answered the same day — **built 2026-10-05**, REQ §13.95–§13.97)
- ~~**H1**~~ ✅ **Merge validity and timing.** A merge never boards at/after the base ride's end and stays within the detour limit; the ride leaves earlier (return ends later) by the added driving. Solver suggestions, board drops/popup, SQL apply and joinable rides use the same rule.
- ~~**H2**~~ ✅ **Connect a הקפצה's two legs on one car** (requester or companion drives both; no volunteer).
- ~~**H3**~~ ✅ **The Sadran changes a request's trip type directly** from the ride sheet; member notified; re-placed on the same car when it fits.
- Answers: boarding rule = detours allowed with an earlier start ("I might put you in the nearest bus station before going to work, so I'll need to go out 15 minutes earlier"); connect legs = yes; trip type = directly.
- ~~**H4**~~ ✅ **"שמירת זמן" is location-neutral** (owner 2026-10-05, REQ §13.96): a reservation holds time only — ignored for car location, chain checks and warnings everywhere; no route editor for it.
- ~~**H5**~~ ✅ **Switching to one-way keeps the return time** (owner 2026-10-05, REQ §13.97): `requests.kept_return_at`; restored on switching back; the form only hides the field.
- ~~**H6**~~ ✅ done 2026-10-05 (owner: "swapping the ride type shouldn't drop any information"): switching to one-way keeps the return *time*, but a request's return-leg **stops** are still dropped (`set_request_trip_type` / `submit_request` delete them when there is no return) — keeping them needs every return-route reader to ignore them while the trip is one-way; ask the owner whether it matters.
- ~~**H7**~~ ✅ done 2026-10-05 — the board's ride/unmet cards show the stops by name ("· דרך: פתח תקווה, תל אביב", "חזרה דרך: …") instead of "· N עצירות" (owner).
- ~~**H8**~~ ✅ done 2026-10-05 — a one-way trip can always become a round trip: with no known return, it is set to departure + route + 2h (nearest quarter hour), return flexibility "any time that day" (REQ §13.98, `20261005190000`).
- ~~**H9**~~ ✅ done 2026-10-05 — a request solved "outside" (`external`: public transport, cab…) is treated like `denied`: it stays on the waiting list / unmet list and gets freed-car offers unless the member opted out (owner; `20261005200000_external_like_denied.sql`, `unmetStatuses.ts`, `myRequestsRows.ts`).
- ~~**H10**~~ ✅ done 2026-10-05 — auto-solve bug (owner report): a round trip from Haifa was never placed after a one-way left the car in Haifa, because round trips are placed before one-way legs and nothing was retried. `runGreedy` now repeats passes over the still-unmet requests until nothing more is placed (SOLVER §3.6.3); no 0-minute "shift" suggestions. The automatic turnaround buffer stays (owner: keep it; only manual placement waives it at a handover).

## Owner rule 2026-10-05 (during QA run 1) — **to build after the run**, REQ §13.99
- **P1 — Only a private car's owner puts requests on it.** Board: a private car's column/rides are not drop or merge targets for the Sadran (toast why); solver: no placement and no merge/changeOrigin suggestion targets a temporary car for anyone but its owner; SQL: `edit_ride`/placement/`create_proposal` (merge) refuse a request on a temporary car unless the actor is the owner (ask-to-join to the owner stays); QA CLI follows the same rule. Check what QA run 1 reports about where the app allowed it.

## QA run 1 findings (2026-10-05, seed 7, week 11–17.10; QA Sadran = Opus, Wednesday via UI; QA user = Sonnet) — **owner triaged 2026-10-05: all bugs + P1 now; accepted features QM5 (published-day proposals) and QM1 (merge into needs-driver rides); QM9 → existing luggage field (confirm wording); copy (QB10, QU6–QU8) drafted for owner review first; every other UI change/feature only after one-by-one approval** (REQ §13.100)
Merged and deduplicated from both agents' reports (S = QA Sadran, U = QA user). Evidence (ids, screenshots) in the run's scratchpad notes; every item names its repro.

### Bugs (most significant first)
- **QB1 — Solver crashes for the whole week after auto-fill** (S1): fixed series pieces are seeded without `seriesId`, so the turnaround buffer applies between one series' consecutive-day pieces → `CarTimeline.forceAdd … overlaps`; no suggestions, no remaining-mode auto-fill, no board preview for the rest of the run.
- **QB2 — Applying a one-leg merge cancels the request's other, separately placed leg** (`MERGED_BY_CONSENT`), silently (S3: Avigail Mon, Shira Thu).
- **QB3 — Merging into a connected הקפצה pair attaches the joiner to the out ride only**, even with "both ways"; the other leg's unmet card disappears while a one-leg draft/merge exists (S4: Noa Wed via UI, Ido).
- **QB4 — Chain healing moves Sadran-placed rides to another car, pairs across an intervening ride, later cancels a pinned ride silently** and strands the car (S5: Yokneam, Mon).
- **QB5 — A pickup placed on the same car as its drop-off gets a relay-length window but stays a chauffeur ride** → impossible 15–30-minute bookings (S6, several days).
- **QB6 — Driver cancellation leaves the passenger on a ghost ride** ("_____ מסיע/ה…", no clear notice, Sadran not alerted, freed seat not offered) (U6).
- **QB7 — Freed cars were never offered** after cancellations; live requests took them first-come-first-served (S9) — first verify the `on-ride-cancelled` edge function runs on the disposable stack.
- **QB8 — A late request overlapping the member's own ride is auto-approved** onto a second car; the board shows no conflict although readiness counts it (U9, S8).
- **QB9 — Proposals go stale silently**: a second merge into the same ride fails for its passenger with `stale_version`; a proposal whose ride was replaced fails with `ride_not_found`; an edit while a proposal is pending leaves old text; the Sadran is not told (U1, U2, S12).
- **QB10 — Merge proposal text is wrong for both parties**: the host gets the joiner's message and times; pickup direction reversed; the earlier departure (§13.95) is never stated; empty "חזרה —"; an out-only merge shows the full window (U3, U4, S2).
- **QB11 — Contested waiting-list groups include people who already have rides and unrelated destinations**; a group stays open after its member is placed; grammar "גם הילה מלכה מבקשים/ות" (U5, S10).
- **QB12 — Resizing a pickup-leg ride is checked against the departure flexibility** → every resize is "beyond flexibility"; on a published day a dead end (S7).
- **QB13 — Status confusion**: published needs-driver rides while the request looks served; a request "waitlisted" while holding a ride; /my duplicates a request and shows "ברשימת המתנה" next to its ride (U12, UI notes).
- **QB14 — "+ נוסעים" (self-add) leaves the member's own request unresolved** (still contested/waitlisted, return leg uncovered), and the notification names the wrong destination (U13).
- **QB15 — Answered/withdrawn proposals still look pending/unread**; the driver is not told when a passenger declines (U7, U8).
- **QB16 — "Car now" goes nowhere when the current week is not live** (filed into the planning week, stays `submitted`, no answer) (U10, S14).
- **QB17 — Multi-day series days show 00:00 times** in my rides, notifications and proposals; series proposals omit the return date (U11, S19).
- **QB18 — Policy scoring fails** (`invalid_publication_scores` at publish; board policy chip errors) (S15).
- **QB19 — A draft does not free the joiner's old booking for further planning** (drop check still counts it; needed `--force`, left a CONFLICT) (S16).
- **QB20 — Private-car rule not enforced** (P1 above; S17: place/move/merge onto private cars accepted; misleading "car unavailable / seats" refusal for a non-owner drop).
- **QB21 — Car column away badge is stale** (first away interval of the week, not the selected day) (S11).
- **QB22 — A request stuck `submitted / PROPOSAL_APPLIED_PENDING_ASSIGNMENT`** although two live rides serve it after an edit-route shift (S13).
- **QB23 — Dropping just below a connected out-leg offered a shift onto a car parked away** instead of refusing/merging (S18).
- **QB24 — Copy/display**: "X הוסיף/ה את X" (U14); merge popup "משאיר/ה את הרכב בחריש לבועז", "08:15 במקום 08:15"; the return relay ride shows the out-stop; external composer preview shows a raw `{{link}}`; group-resolve "על שם אלון שגיא עם אלון שגיא"; proposal expiry at publish notifies the Sadran "בקשה חדשה…"; solver stats print "relocations"; the planning-week notification shows a past deadline/stale week (U16 — check whether it is a generator artifact).
- QA tooling (not the app): `resolveCar` accepts only id prefixes while ids print as suffixes; `publish` label; no CLI command to assign a chauffeur driver, add passengers, ask to join or look up contacts; `qa:member proposals` shows a raw `{{link}}`.

**Fix status (2026-10-05, migrations `20261006100000`–`…200800`; SQL suites `qa_run1_proposals.sql`, `qa_run1_cancel_waitlist.sql`):**
- Fixed: QB1 (`FixedRide.seriesId`; `forceAdd` records `FIXED_RIDE_CONFLICT` instead of throwing; also in `on-ride-cancelled`), QB2, QB3 (server side: a "both ways" join into a connected pair becomes one leg per ride), QB4, QB5, QB6 (ride kept as missing-driver, passengers `driver_cancelled` with COPY_DRAFT §6 wording, Sadran `driver_cancelled_sadran`), QB8, QB9 (host fingerprint instead of version equality; withdrawals notify the Sadran), QB11 (REQ §13.100 a; singular grammar variant), QB12, QB13 (SQL `sync_request_coverage`; /my lists each request once), QB14, QB15, QB16 (`car_now_week_not_live`), QB18, QB19, QB20/P1 (SQL `private_car_owner_only` in placement/proposals/`edit_ride`/`add_ride_passengers`; board refuses; solver never merges into a temporary car; no freed-slot offer for a private car), QB21, QB22, QB23 (refuses a drop onto a car parked away from the request's origin), QB24 except below, QA tooling. Accepted features: QM5 (Sadran `shift`/`merge` on a published day), QM1 (merge into a needs-driver ride).
- QB7: the SQL path works; the disposable stack needs `on_ride_cancelled_url`/`push_dispatch_url`/`cron_secret` set (docs/QA_SIMULATION.md).
- Open: QB3's merge popup still previews only one ride for a connected pair; QB17 series return date not yet in any template (`seriesReturnDay` var exists; copy pending owner); QB24 "return relay ride shows the out-stop" (not reproduced); QB14 wrong destination (not reproduced). New copy awaiting owner review: `he.errors.privateCarOwnerOnly`, templates `withdrawn_ride`/`withdrawn_edit`/`declined_party`/`driver_cancelled_sadran`/`duplicate_overlap`, `he.errors.proposalDayPublic` (now only true for deny/external/origin), docs/COPY_DRAFT_2026-10.md.
- **Owner answers 2026-10-05 (late):** (1) a large-luggage request **requires** a `large_trunk` car (REQ item 21 changes); relabel the field "ציוד רב — צריך תא מטען גדול" + hint. (2a) COPY_DRAFT texts approved (may change after beta). (2b) **No "use your own car" variant** — never suggest it (the private car may be in use by the household); external keeps two variants: no car in your town / every car taken. (2c) Other passengers are told **every time** someone joins (revert to driver-only if too noisy). (2d) Name the Sadran by **display name**, and never "זה/זו X, הסדרן/ית" — everyone knows each other; the opener is "פונה אליך בכובע של הסידור" style. (3) The live bug-fix texts and my four proposed texts approved (may change after beta). (4) Merge popup previews both rides of a connected pair. (5) Commit this batch on the branch once green.
- **Owner triage of UI changes/features (2026-10-05, late):** build now: QU1 (bug), QU2, QU3, QU5, QM2, QM3 (warning only), QM4 (member may answer "not a duplicate"), QM5 (published/live day: member edits, waiting list if no car; closed-unpublished: contact the Sadran), QM7, QM8, QF5, QF7. No: QU4 (by design). Later: QU9, QF1, QF3, QF4, QF6, QF9. Dropped: QF2 (contradicts §13.100 a), QF8 (contradicts binary answers). All recorded as REQ item 101.
- **Built 2026-10-05 (migrations `20261007100000`–`…200800`; suites `proposals_copy_and_series_span.sql`, `placement_features.sql`):** REQ 101 a–k. Copy per reader (two external variants, "בכובע של הסידור" opener, `joined_ride` to everyone on a ride, `merge_passenger_no_driver`/`merged_no_driver` for rides still needing a driver, `declined_party` names who declined). `set_ride_driver`, `withdraw_duplicate_request`/`restore_duplicate_request`, `place_on_own_car`, published-day edits (`needs_confirmation` probe with `drives_others`/`would_place`), `overlaps` in the submit response, large luggage only on `large_trunk` cars (`UNMET_NEEDS_LARGE_TRUNK`), freed cars held for an overlapping contested group (`freed_slot_offers.group_id`), fewer-days `series_span` shifts. Board: full-width grid, drag auto-scroll, no text selection, axis scroll padding, day kept after proposals, flexibility + connected-pair preview in the merge popup, driver picker, duplicate-child warning, withdraw-as-duplicate, "להציע פחות ימים". Member: equipment label, overlap dialog, published-day edit confirmation, own-car button, "not a duplicate".
- Still open: generic "שינוי בסידור שלך" after publish/re-solve keeps today's text (old values not captured at publish); `trip_type_changed` has no actor name; QU2 needs a browser check.

### UI changes
- **QU1 — The board ignores screen width**: only ~6 of 13 car columns visible at 2000–2600px inside a ~770px scroller; no auto-scroll while dragging; a drag can turn into text selection (S, Wed).
- **QU2 — The sticky time axis covers half of the next car column** after a horizontal scroll (S).
- **QU3 — After sending a proposal the board returns to Sunday**, not the day being worked on (S).
- **QU4 — Private cars are hidden on days without rides**, so the Sadran cannot see their availability (S).
- **QU5 — The merge popup does not show the parties' flexibility** (S).
- **QU6 — The "external" proposal is one generic text** for very different cases (no car in your town / use your own car / genuinely nothing) — needs distinct reasons (U).
- **QU7 — Proposals should state old → new explicitly, per reader**; a driver's version should be short and their own (U, S).
- **QU8 — "שינוי בסידור שלך" notifications say only "<car> · 12/10 11:45"** — need what changed, who changed it, and a button (U).
- **QU9 — Joining a long (series) ride adds you for the whole day** — choose the leg/time (U).

### Missing obvious features
- **QM1 — Merge into a needs-driver chauffeur ride** (parallel school runs to the same place cannot be combined) (S).
- **QM2 — The Sadran assigns a volunteer driver** to needs-driver rides (32 were published) — check what the board already offers (REQ §7 lists "assign a driver to a chauffeur leg") (S).
- **QM3 — Duplicate detection for parent pairs filing the same child run** (S).
- **QM4 — Sadran-side withdrawal of a duplicate request** (S).
- **QM5 — A change after publication**: the member asks for a change / the Sadran records the member's OK on a published day (today: `request_window_closed` for the member, `proposal_day_public` for the Sadran) (U, S).
- **QM6 — Notices**: passenger when the driver cancels (with a re-offer), driver when a passenger declines or withdraws (U).
- **QM7 — Overlapping own request**: ask "cancel the other one?" instead of auto-approving (U; see QB8).
- **QM8 — A one-tap "post this on your own car" for private-car owners** (fits §13.99) (S, U).
- **QM9 — A "big car / equipment" request field** (three members asked) (S).

### Additional features
- **QF1 — Volunteer-driver matching** for driverless rides (push to members passing the same route) (U).
- **QF2 — Route-aware contested groups** (cluster by destination/corridor, exclude people with rides) (U; see QB11).
- **QF3 — Lend a car parked away** (e.g. in Zichron during a series) to members starting there (S).
- **QF4 — Origin change with "pick me up to the car's base"** (S).
- **QF5 — Partial-series counter-offers** ("2 days instead of 3") (S).
- **QF6 — Series served by passenger legs, middle days marked covered** (S).
- **QF7 — Freed-car offers prioritised to that day's contested group** (S).
- **QF8 — Passenger "accept but ask for a time change" inside the proposal** (~15% negotiated by message) (U).
- **QF9 — A "who is joining my car" view for private-car owners**, with an approve step (U).

## QA run 2 findings (2026-10-06, seed 6044, week 11–17.10, department `qa-s6044`; QA Sadran = Opus, Wednesday via UI; QA user = Sonnet) — **owner triaged 2026-10-06 (REQ item 102): all bugs; R2Q1 a–c, R2Q2, R2Q3, R2U1–U5, R2M1–R2M5 (R2M4 warn only) now; R2F1 not now (bigger cars may be preferred for long rides, mileage matters); R2F2 to do, not now; R2F3/R2F4 later**
Merged and deduplicated from both reports (S = QA Sadran item, U = QA user item; full reports and screenshots in the run's scratchpad). Auto-fill served 91 of 146 legs; unmet at the end: Sun 8, Mon 7, Tue 7, Wed 12, Thu 10 (mostly no car at the member's town, seats, every car taken at zero flexibility, pickup legs needing a driver).

### Bugs (most significant first)
- **R2B1 — A proposal pending at publish can never be accepted** (`stale_version`: publishing bumps every ride's version, the proposal still checks the host's old one); it stays "sent" and the Sadran is not told (S1, U1: Mon 70ddb543, Wed d5e3aeb1).
- **R2B2 — Two accepted proposals on one ride: the second undoes the first** (merge applied with the host's pre-shift window → the shift is lost, the next ride has a 0-minute turnaround, no warning) (S2: Sun ride b5a35694).
- **R2B3 — `on-ride-cancelled` crashed** (`duplicate key … ride_requests_out_unique_idx`, re-inserting an already placed out leg) → the freed car was offered to nobody; the offer also stayed open after the time was given through the waiting-list group (S3: Thu a54140ac, offer 6f8f1125).
- **R2B4 — Merging into a multi-day ride shows/sets departure 00:00** ("יציאה 00:00 במקום 07:00"; published ride 00:00–16:15) (S10, U2: Mon 25c1cf0d).
- **R2B5 — "להציע פחות ימים" proposes the wrong span** (Mon only, no car) and its car list offers only a car parked away (S5: Ido Hershkovitz 7b357fd6).
- **R2B6 — Withdrawing a request leaves rides that start where the car no longer is** (no healing, no warning) (S6: Wed c3b5859d → 19352d8c, e008eb6a).
- **R2B7 — Dropping a card on a ride can create an overlapping ride with a success toast** instead of a merge or a refusal (round trips; a pending-merge block); undo is disabled after a drop from the unmet list (S7: Wed 3b82c9a8 → 83cc21d3, a44bb8cf → 29ccb5b5).
- **R2B8 — The board refuses drops the server accepts**: a pickup leg onto the car parked at the pickup place, a "pick me up from X" הקפצה onto a car at home ("car not at departure place" — the QB23 check is too broad) (S8: Wed ecd27c3a, 0e412dc7).
- **R2B9 — A pickup chauffeur ride uses two different times** (placed 12:30–13:00 labelled "(יציאה 12:30)", moving it is refused as beyond flexibility) (S9: Wed ecd27c3a).
- **R2B10 — Proposal/notification copy still wrong in places** (S10, U3–U8): empty values ("חזרה 14:30 במקום .", "08:30–."); non-changes ("09:00 במקום 09:00"); out-only merges mention a return; return-only merge headline without a subject / "מסיע/ה את רועי…"; guest vs host times differ (09:45 vs 09:30; push 10:34 vs text 11:00); the window printed twice; host told "X מבקש/ת להצטרף אליך" when the Sadran proposed it; "אפשר לשבץ אותך אם מזיזים" / origin "אין רכב בגבעת חביבה" sent to members already placed; external "אין כרגע רכב בחיפה מחיפה", the Sadran's reason appended after the link, "אפשר להגיע לקיבוץ" for a trip *to* the kibbutz; group notices "ביום 11/10" without the weekday and "עידו הרשקוביץ נוסעים/ות" for one person.
- **R2B11 — Solver reasons stale or empty**: UNMET_NO_RELAY_PARTNER still says "home by 23:59"; UNMET_NO_CAR shows an empty "חוסמים:" when the cause is seats or no car at the origin; the cab suggestion listed twice (S11).
- **R2B12 — Suggestions that make no sense**: changeOrigin to the request's own origin; convertToRoundTrip where no car is at the origin; no changeOrigin offered although cars were free at home (S12: Thu cf3d6dea, Wed 0e412dc7, Tue df419774).
- **R2B13 — The same merge sent twice** (the second after the first was accepted), and a second draft silently withdraws the first (U7, S18).
- **R2B14 — Member siddur car header shows an away place on every day** (QB21 fixed on the board only) and "· קוד לא הוזן" on every car, private cars included (S14).
- **R2B15 — The ride sheet shows the volunteer driver twice** after `set_ride_driver` (React duplicate key) (S15: ride 6049e8aa).
- **R2B16 — An origin change leaves the new origin as a stop** ("חדרה->חדרה via חדרה") (S16: Sun 137c31ad).
- **R2B17 — Wrong refusal reason** ("time conflicts" when the cause is seats) (S17: Mon 28169ba4 → b30cccba).
- **R2B18 — Statuses**: "waitlisted" / `UNMET_NEEDS_DRIVER` while a ride serves the request; /my shows the whole ride window to an out-only passenger; "נמצא נהג/ת" sent for an unpublished day (S19, U-UI5).
- **R2B19 — Connected-pair driver labels wrong** when the other leg's person is a passenger on a ride still needing a driver ("משאיר/ה את הרכב במענית לרועי") (S20).
- **R2B20 — Edits give no feedback**: editing an assigned request in an open week silently returns it to "submitted" (the car is lost); a post-publish edit that was auto-approved sends no confirmation (U10, S missing-1).
- **R2B21 — An unanswered external proposal stays pending while the member sits in a contested group** (U11: Sun 85eef4fb); an edited request did not join the open group while a late request did (S13).
- **R2B22 — /my says "לא הגשת בקשות לשבוע הזה" below a list of requests** (U-UI1, m35 mobile).
- **R2B23 — Siddur missing-driver card shows a placeholder** "_____ אוסף/ת את דניאל מגן שמואל" (U-UI2).
- **R2B24 — A refused ask-to-join shows the raw code `DUPLICATE_OVERLAP`** and a home→home route, not which own request it overlaps (U-UI4).
- **R2B25 — Merge popup**: a return-leg card offers only "הלוך בלבד / הלוך וחזור"; an off-grid ETA (12:53); the header says the ride keeps its start (contradicts §13.95) (S UI).
- QA tooling (not the app): `qa:member` cannot resolve a contested group; `ask-to-join` files the ride's end place as the destination; CLI `merge` refuses needs-driver rides; CLI drop checks ignore drafts; no fewer-days / withdraw-duplicate commands; `contacts` lacks emails; CLI siddur prints the car's home→home instead of the route; car-now cannot be exercised in a future QA week.

**Fix status (2026-10-06, migrations `20261008100000`–`…200200`; suites `qa_run2_proposals.sql`, `qa_run2_placement.sql`):**
- Fixed: R2B1 (answers stand; an accepted proposal that can no longer apply is withdrawn and the Sadran gets `withdrawn_stale` with the reason), R2B2 (apply uses the ride's current window; `merge_turnaround_conflict`), R2B3 (`place_freed_slot_request` places only missing legs), R2B4, R2B5, R2B7, R2B8 (`legStartPlaceId`), R2B9 (TS: pickup ride judged by its end against return flexibility), R2B10 (copy round 2: `shift_placed`/`origin_placed`, `merge_passenger_split`, `external_city_home`, host "אני מציע/ה לצרף"), R2B11, R2B12, R2B13 (`merge_already_on_ride`), R2B14, R2B15, R2B16, R2B17, R2B18, R2B19, R2B20, R2B21, R2B22, R2B23, R2B24 (named toast), R2B25; QA tooling. Built: R2Q1 a–c, R2Q2, R2Q3 (per-ride publish lines), R2U1–U5, R2M1 (`probe_only` → `would_lose_booking`), R2M2 (split merge, one proposal, draft extends), R2M3 (`code` on `_merge_check`/`merge_preview`), R2M4 (`child_request_overlaps`), R2M5 (`external_accepted`).
- Partial: R2B6 flags later rides + notifies the Sadran (`car_chain_broken`) instead of re-anchoring them; a split-merge draft draws its ghost on the first ride only; R2B24's home→home route not reproduced.

### Owner questions
- **R2Q1 — Contested groups and origins** (S13, U12): groups mix members starting in Haifa/Zichron/Yokneam (no car there) with Givat Haviva members, show no car, form even when no car is free, and chain non-overlapping trips (07:15 and 16:00 via a middle one).
- **R2Q2 — Freed-car offer window** (S4): offer the car's real free gap (Suzuki free 09:15–15:00), not just the cancelled ride's hours (11:30–14:30)?
- Not done from the approved copy: the generic "שינוי בסידור שלך" / published notice per changed ride (COPY_DRAFT §7, needs old values captured at publish) (U-UI3, S10).

### UI changes
- **R2U1 — Sending a draft**: a small draft block opens the guest chip, not the sheet; "שלח" reads like a failure ("הטיוטה נשמרה… אפשר לנסות לשלוח שוב").
- **R2U2 — Trip-type select on the unmet card applies at once** and notifies the member, no confirmation; the card keeps the old label.
- **R2U3 — Volunteer-driver picker** lists all members with no hint of who is busy at that time.
- **R2U4 — Sadran inbox noise**: every late request makes three notifications (late, waitlisted, contested).
- **R2U5 — "הרכב מחכה בגן שמואל"** card has no route (U-UI2).

### Missing obvious features
- **R2M1 — Warn before an open-week edit loses the car** (see R2B20).
- **R2M2 — Compose a split merge by hand** (out with ride A, back with ride B).
- **R2M3 — Every merge refusal says why** (seats / detour / boards at the end).
- **R2M4 — Warn a parent at submit** when their child is already on the partner's overlapping request (today only the Sadran sees it) (U-M4).
- **R2M5 — A clear notice after accepting an external proposal** (today the generic "שינוי בסידור שלך | 13/10 06:45") (U-M2).

### Additional features
- **R2F1 — Prefer smaller cars for one-person multi-day rides and long holds** (a 3-day series held the only 7-seat van; a הקפצה pair held it 5 h).
- **R2F2 — Link the two guardians of a child** so a child on one parent's request shows on both.
- **R2F3 — Offer "join the out leg only"** when the return shift is large.
- **R2F4 — Message the driver, or volunteer to drive, from the member's ride card** (overlaps QF1, later).
- Related to "later" items: put a car based away from home to use for members starting there (the Hadera Mazda idle all week — QF3).

## QA run 3 findings (2026-10-06, seed 6731, week 11–17.10, department `qa-s6731`; QA Sadran = Opus, Wednesday (busiest, 33 requests) via UI; QA user = Sonnet) — **owner triaged 2026-10-06 (REQ item 103): all bugs; R3Q1 → connect legs only when no other request needs the car; R3Q2 → the Sadran marks a car move (reservation dialog), automatic fetching later; R3U1 and R3F2 build; R3F1 later**
Merged from both reports (S = QA Sadran, U = QA user). Whole week published; unmet at the end: 9 waitlisted, 13 external, 2 denied (mostly members living where no car is, Mon load, the stuck group of R3B9). **Regressions of items reported fixed in the QA run 2 batch: R3B9 (R2Q1 b), R3B11 (R2M2), R3B15 (QU3), R3B16 (R2B15), R3B6 (R2B10).**

### Bugs
- **R3B1 — A merge accepted by both parties ends `withdrawn`** after the Sadran assigned a volunteer driver to the host ride (or another ride on that car) — the fingerprint changed; nobody is warned, the members who accepted are not told (S1: Wed e8b475b1, Sun 5c91838b).
- **R3B2 — Dragging a needs-driver הקפצה ride onto another needs-driver ride** moves it 75 min beyond its 0/0 flexibility, overlapping the host, with the toast "הוזז בתוך הגמישות" (no merge popup) (S2: Wed 8585c814 → 09013b9e).
- **R3B3 — Green drop preview, then a server refusal shown as "אירעה שגיאה" + raw English** ("chauffeur legs must start and end at the same place…") for a pickup onto an idle car based away (S3: Wed 64c60880:return, Seat at חדרה).
- **R3B4 — A drop 15 min after the requested time snaps back** to the requested time and is refused as overlapping (`unmetCandidateWindow`) (S4: Tue 24d75fbd).
- **R3B5 — A red-preview drop is applied without confirmation**, creating a chain conflict with the next day (S5: Wed 3fa43837).
- **R3B6 — Return-only merge text has the wrong direction/times** ("מסיע את דור לזכרון יעקב… יציאה 16:15, חזרה 16:45" for a return from Zichron); the popup says "אי אפשר לחשב את זמן העצירה" (S6, U3: Wed 28cf69ae).
- **R3B7 — `freed_slot_auto` body ends "13:30–15:00 ל."** (destination missing) (S7, U6: Sun 5b4ede58).
- **R3B8 — A late waitlisted request placed onto a confirmed ride (live) is not notified** (S8: Tue 98c5b0e1).
- **R3B9 — A contested group forms where no car can serve anyone**; resolving always fails `no_car_free`, even for one member; the siddur shows an extra "00:00–18:45" line under the group block (S9, U1, U-UI2: Wed 9159fe43).
- **R3B10 — Ask-to-join is auto-approved onto a separate free car** instead of becoming a merge with the asked ride (two cars for one trip, the driver not told); another ask-to-join used the member's default origin (חדרה) although the ride starts at home (S10, U7: Tue 3477efa6, 2a848950).
- **R3B11 — Split merge does not work**: the second leg's merge replaces the first ("expired"), sending a draft for the other leg fails `stale_version` (S11: Mon 5fd5469b).
- **R3B12 — A passenger cancelling leaves the driver's ride without notice** (U2, U-M2: Mon cf20b773 → dd0f35dc, driver m36).
- **R3B13 — A proposal shows only the new time** ("יציאה 06:45", request was 07:30 — no old → new) (U4: Tue 54d03896).
- **R3B14 — A published-day edit (+30 min) silently moves the ride to another car**; the notice "העריכה נשמרה והבקשה שובצה" has no old → new and no car change (U5: Mon 1d44067a).
- **R3B15 — After sending from the composer the board returns to Sunday** (S UI).
- **R3B16 — The ride sheet shows the volunteer driver twice and the picker stays open** (S UI).
- **R3B17 — Ride text shows through the sticky car-header row; drag auto-scroll runs onto the "רכב חסר" columns** (S UI).
- **R3B18 — The `TIME_NOT_ALIGNED` warning shows as a raw code** (reasons.ts has the Hebrew) (S UI).
- **R3B19 — Labels/copy**: a one-way ride to home labelled "(הרכב נשאר שם)"; a lone הקפצה labelled "משולבת"; an origin-change draft drawn with the old origin; the publish recipient list shows requested instead of placed times; the duplicate-child banner line repeats; the shift composer's starting text "השעות שלך לא משתנות"; the time picker opens at 00 (S UI).
- **R3B20 — The merge popup defaults to "הלוך בלבד"** for a round-trip guest whose return also fits (S UI).
- **R3B21 — A return stop equal to the destination is accepted** (S UI).
- **R3B22 — `set_ride_driver` accepts a volunteer riding elsewhere at that time** (only the UI picker warns) (S M4).
- QA tooling: `qa:member answer` omits the proposal type; `qa:ui shot --day` finds no day tab; `qa:member cancel` on a waitlisted request ("no ride to cancel" — members withdraw); `my-rides` prints the car's home→home; the QA user's CLI submissions bypass the form warnings (overlap, child) by design.

**Fix status (2026-10-06, migrations `20261009100000`, `20261009200100`–`…201500`; suites `qa_run3_proposals.sql`, `qa_run3_placement.sql`). Reproduced on the QA week before fixing (REQ 103 e) unless noted:**
- SQL, reproduced + verified: R3B1 (`_ride_fp` ignores driver fields; members who accepted are told when a proposal is withdrawn), R3B6 (joiner route/times per leg), R3B11 (extends a sent unanswered merge too), R3B3 (machine code `leg_location_mismatch`), R3B7, R3B8, R3B9 (groups need a member a free car can serve; stale groups dissolve), R3B10 (ask-to-join never auto-approved, origin from the asked ride), R3B12 (`passenger_left`), R3B14 (`app.edit_prefer_car`, `car_changed` notice), R3B22 (`driver_busy`); REQ 103 a in SQL + solver (wait "needed" = other overlapping requests ≥ shared cars), 103 b `mark_car_move` (`auto_relocation` + `pin_reason CAR_MOVE`), 103 c `shorten_series` (1..n−1 days).
- UI: R3B15 (selected day in sessionStorage) and R3B17 header verified on the QA week; R3B2–B5, R3B16, R3B19, R3B20, R3B21 fixed from code + unit tests (not reproduced in the browser); R3B6 composer/draft texts now get the merged legs (`mergeLegSummary`); R3B11 popup leg toggle keeps a split merge's other leg; R3B18 solver warning text; R3U1, R3F2 built; car-move labels on board and siddur.
- Not reproduced: R3B13 (stored notification already old → new). Known: R3B8's member notice reuses the `edit_applied` copy ("העריכה נשמרה והבקשה שובצה"); R3B5 preview does not detect next-day chain conflicts.

### Owner questions
- **R3Q1 — Connected הקפצה legs park a shared car 5–9 hours at a place 5–10 minutes away** (Mon, Wed, Thu, several cars) while other requests stay unmet; there is no "two short legs, the car comes home" choice (S M1).
- **R3Q2 — A car idle away from home** (the Seat at חדרה, all Wednesday) can only be used through an origin-change proposal; a "fetch the car" ride? (S M2; close to QF3, later).

### UI changes
- **R3U1 — On mobile /my the install-app and push-blocked banners push "my upcoming rides" below the fold** (U-UI1).

### Additional features
- **R3F1 — A day-level "merge same-destination rides" hint** (Tue 17:30: 3 cars to כפר סבא; Sun: 3 הקפצות to כרכור 07:15–07:45) (S F1).
- **R3F2 — A member shortens their own multi-day request** (U F2).
- Not findings: a decline reason (answers are binary, decision 21); the overlap/child warnings (built in the form; the CLI bypasses them); separate requests and 00:00–23:59 middle days of a multi-day request and its cascading withdraw (REQ §13.77 by design).

## QA run 4 findings (2026-10-06, seed 1059, week 11–17.10, department `qa-s1059`; QA Sadran = Opus, Thursday via UI; QA user = Sonnet) — **owner triaged 2026-10-06 (REQ item 104): all bugs; R4Q1, R4Q3, R4Q5 yes; R4Q2 no; R4Q4 future; R4U1–U7 build; R4F3 build; R4M1, R4F1, R4F2 not now**
Merged from both reports (S = QA Sadran, U = QA user). Worked: car move (UI + CLI), merge into a needs-driver ride, drafts drawn/sent from the board, publish flow, busy marks in the driver picker, late requests auto-approved, a freed-car offer correctly closed with no eligible candidate. Unmet at the end: Sun 9, Mon 9, Tue 5, Wed 9, Thu 6 cards + ~35 rides without a driver (lone all-day commuters on every car, scarce child-seat cars, members living where no car is, zero-flexibility declines, big-trunk needs).

### Bugs
- **R4B1 — Auto-fill does not finish in one click** (87 placed, then +4, then more; the day view keeps saying "would place") (S1).
- **R4B2 — Connecting a הקפצה's pickup next to its drop-off says "שתי הנסיעות חוברו — המבקש/ת נוהג/ת בשתיהן" but saves two driverless chauffeur rides** (route home→X→home each) (S2: Thu 9849c1e2 UI, Sun a900430d CLI).
- **R4B3 — A draft from dropping an unmet הקפצה outside its flexibility has no `car_id`** — not drawn, the car looks idle (S3: Thu 9cc731e4 → 7a52486b).
- **R4B4 — A draft from dropping a pickup ("איסוף") card has no leg/car** (`{depart 07:30, return 14:15}`) and is drawn as a 07:30–14:15 block replacing the out-leg ride and overlapping another ride (S4: Thu aec7afd5 → 2deac9e1).
- **R4B5 — Times disagree between the merge popup, the composer, the notification and the other party**: popup 07:45 vs composer 08:00 (d6e0ffc9); 11:15 vs 11:45–16:15 (345fa0db); notification return "12:45 במקום 13:30" vs proposal 11:00–13:15 and the driver's 13:15 (3a6d19dc); "שובצת… יציאה 07:30" vs the ride's 06:30 (Thu 40c64dbf) (S5, U1, U2).
- **R4B6 — A guest's merge text drops their own stops and destination** (via חדרה/קניון, כפר סבא shown while the ride goes to רעננה; 07:00/16:30 → 08:00/18:00 without "במקום") (U3: Thu 02ee311b).
- **R4B7 — A chauffeur ride from a car parked away omits the empty drive to the pickup** (car at חדרה, pickup at חיפה at the ride's start minute) (S6: Sun 68032462).
- **R4B8 — Cancelling one leg of a הקפצה returns that leg to the unmet list** instead of ending it; a spurious "העריכה נשמרה והבקשה שובצה" arrives for a member who edited nothing (S7, U2: Tue 5bffadd9, Thu 40c64dbf/820118c2).
- **R4B9 — Rides "confirmed" while still without a driver**, the request `waitlisted(UNMET_NEEDS_DRIVER)` (U4: Tue 4040b6f0, Thu 820118c2, Mon 08f14851).
- **R4B10 — Declining an external proposal fails `proposal_not_answerable`** with no explanation (U5: Sun 8e465fbd — expired at publish 3 minutes after it was sent).
- **R4B11 — Labels and checks**: a הקפצה whose legs are on separate chauffeur rides is labelled "משולבת" (Thu cb1850e7, Wed b269ad01); a drop check says "would strand" when the real refusal is `private_car_owner_only` (Sun 145a45d3); kids' drop-offs blocked by child seats report `UNMET_NO_RELAY_PARTNER` with only a cab suggestion (Mon 10775417, 96d8dcff, 94502de2); publish shows "80/139 placed" while the solver reports 109 served; a drop-off's out-leg shows "גבעת חביבה->גבעת חביבה" in my rides (U-UI3) (S U3, U4, U7, U9).
- QA tooling: `qa:ui shot` timed out at sign-in for members (m06, m17, m07) — no member UI check on Thursday.

**Fix status (2026-10-06, migrations `20261010100000`–`…100400`, `20261010200000`–`…201100`; suites `qa_run4_proposals.sql`, `qa_run4_placement.sql`):**
- Reproduced + fixed-verified on the QA week: R4B1 (unmet relay pairs fall back to chauffeur legs in the same solve; re-solve adds nothing — fuzz test), R4B2 (manual connect skips the demand guard), R4B5 (`_joiner_times` from the merged route; `merge_preview` `joiner_depart_at/return_at` + `joiner_old_*`), R4B6, R4B9 (driverless rides are `flagged`/`NEEDS_DRIVER`, never `confirmed`; requests `waitlisted`/`UNMET_NEEDS_DRIVER`; `merged` only when riding in someone else's ride), R4B11 count (`placedRequests`/`awaitingDriverRequests`).
- Fixed, verified by test only: R4B3, R4B4 (single-leg shift payload `leg`+`car_id`; `app.place_only_leg`), R4B7 (solver + `extend_chauffeur_pickup_drive` safety net, out legs), R4B8 (cancelled leg ends: `one_way_to`/`one_way_from`; no spurious `edit_applied`), R4B10 (`proposal_expired`), R4B11 labels. Built: REQ 104 a (relay pairs + `car_wait_needed_elsewhere`), b (`merge_short_drop_off_rides`, wait ≤ 2 × turnaround; solver `chauffeurShortDropOffs`), c (solver `kidSeats` rank, `UNMET_NO_CAR_SEATS_BUSY`), e (`{{titleChange}}`), f (R4U1–U7). QA tooling: member sign-in retry. Not reproduced: the A→A label in my rides.

### Owner questions
- **R4Q1 — Cross-request relay pairs park a car at X all day** while round trips go unmet (Tue Corolla at גן שמואל, Thu minivan at פרדס חנה; converted by hand, each freed car served an unmet request) — apply the R3Q1 rule (pair only when the car is not needed elsewhere) to these pairs too? (S8)
- **R4Q2 — The solver never uses a member's own idle private car for their own request** (5 cases; manual placement works) — place it automatically, suggest it, or leave it to the one-tap button? (S9)
- **R4Q3 — Child-seat-aware car choice**: lone adults take the cars with two child seats, kids' drop-offs go unmet — keep child-seat cars for children? (S M1)
- **R4Q4 — Volunteer drivers**: ~35 rides needed a driver; the Sadran sent 13 free-text mailbox asks — an in-app "can you drive?" ask with accept/decline (close to QF1)? (S M3, U F1)
- **R4Q5 — One chauffeur ride for a short drop-off + pickup** (Thu 63837f85 uses two cars at 10:45) — when the wait is short, should the driver wait/stay and do both on one car? (S M2)

### UI changes
- **R4U1 — A 15-minute ride card is ~20 px and covered by the away band/sticky header** (S U1).
- **R4U2 — Car-move dialog**: date without weekday, title stays "שמירת זמן", the destination list includes the car's current place (S U2).
- **R4U3 — Merge popup shows the guest's new boarding time but not the new return time; merge texts for the guest show only new times** (S U5, U-UI1).
- **R4U4 — Publish confirmation does not warn that pending deny/external proposals expire at publish** (S U6).
- **R4U5 — Volunteer picker: no hint of where members live; a car based away shows the "away" hatch all day while at the kibbutz** (S U8).
- **R4U6 — After accepting, my rides still shows the proposal as pending** (no "you accepted, waiting for the others") (U-UI2).
- **R4U7 — "נהג/ת שעוד לא נמצא/ה מסיע/ה את…" reads badly** → "הנסיעה עוד מחפשת נהג/ת" (U-UI4).

### Missing obvious features / additional
- **R4M1 — Members who cancel get no inbox confirmation**; to verify: does the driver get `passenger_left` when a passenger leaves a shared ride (R3B12) — the QA user could not see the driver's side (U M1, M2).
- **R4F1 — A chauffeur ride from a car away from base could end at home** (S F1). **R4F2 — Car-move duration from travel time** (default 60 min) (S F2). **R4F3 — Old → new and extra minutes in every proposal's inbox title** (U F2).
