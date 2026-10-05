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
