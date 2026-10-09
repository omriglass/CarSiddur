# Test map — change → tests → QA impact

**Purpose.** For any change, know two things fast: (1) which automated suites already prove it,
and (2) a precise, minimal manual checklist to hand QA — "we touched multi-day requests, test
that…" — instead of "please re-test everything." Separation below is by **impact area**, not by
`src/features/*` folder, because coupling in this app runs through a few shared pieces
(`RequestForm`, `WeekGrid`, `v_board_rides`, the solver, the notification pipeline) that cut
across feature folders.

**How to use this.** Run `npm run impact` (see `scripts/impact.mjs`) after making a change; it
diffs against `origin/main` (or a ref/`--staged`/`--files` you give it), matches changed paths
against the **paths** globs below, and prints: the affected areas, the exact Vitest/SQL/Playwright
commands to run locally, and the QA checklist below concatenated and ready to paste into a PR
description or hand to a human tester. Automated suites are **still a full hard gate before every
deploy** (`npm run check:full`) — this map is for QA *effort* and fast local iteration, not a
replacement for the gate.

`test-map.json` at the repo root is this document's machine-readable twin — same area ids, same
paths/suite lists, consumed by `scripts/impact.mjs`. `scripts/impact.test.mjs` asserts the two
never drift apart (same set of area ids) and unit-tests the glob matcher.

Hebrew strings quoted below are copied verbatim from `src/i18n/he.member.ts` / `he.sadran.ts` /
`he.admin.ts` — never invented. Seeded users (`e2e/helpers.ts` `SEEDED_USERS`): `admin`, `sadran`,
`member1`, `member2`, all in the one seeded department `נבו`.

## Shared fan-out (touch one of these, several areas light up)

- `src/components/WeekGrid.tsx` (+ `weekGridCars.ts`) — the day/week grid component shared by the
  member siddur and the Sadran board → **siddur** and **board** both light up.
- `src/features/requests/components/RequestForm.tsx` — the one request form for both the weekly
  and quick/car-now variants (`variant: 'weekly'|'quick'`) → **request-form**, **quick-request**
  and **waitlist** (the waiting-list join dialog reuses request submission) all light up.
- `src/solver/**` — pure placement/scoring engine, read by the board's "run solver"/"auto-fill",
  the freed-slot edge function, and publication's readiness/score preview → **solver**, **board**
  and **publication** all light up.
- `supabase/migrations/**` — most migrations are attributed to an area by filename keyword (best
  effort, see each area's `paths`); `scripts/impact.mjs` additionally greps the *content* of any
  changed `.sql` migration for three especially cross-cutting symbols and adds bonus areas
  regardless of filename: `v_board_rides` → board/siddur/ride-passengers/publication,
  `enqueue_notification` → notifications, `publish_siddur` → publication/board/siddur/waitlist.
  A migration matching neither a filename keyword nor a content rule shows up as **unmapped** —
  that is a prompt to add a glob or content rule here, not a bug to silently ignore.
- `src/i18n/he.member.ts` / `he.sadran.ts` / `he.admin.ts` — mapped best-effort to every area whose
  screens draw from that namespace (member-facing areas for `he.member.ts`, Sadran-facing for
  `he.sadran.ts`, admin screens for `he.admin.ts`); see each area's `paths`.

## Areas

### request-form — Request form & multi-day (series) requests

**Paths**: `src/features/requests/components/RequestForm.tsx` + `requestForm/**` (its field groups),
`TemplateSuggestions.tsx`(+test), `RequestRow.tsx`(+test), `myRequestsRows.ts`(+test), `upcoming.ts`(+test), `series.ts`(+test),
`src/pages/HomePage.tsx`, `MyHistoryPage.tsx`, `RequestsRedirect.tsx` (the one "my rides" screen, REQ §13.91),
`templatePrefill.ts`(+test), `duplicate.ts`(+test), `mapper.ts`(+test), `duration.ts`(+test),
`dayLabel.ts`(+test), `destinationLabel.ts`(+test), `seatCounts.ts`(+test), `schema.ts`(+test), `submitOutcome.ts`(+test), `api.ts`, `hooks.ts`,
the sentence layout (REQ §13.110: `requestForm/sentence/**`, `timeAnchors.ts`, `enteredTimes.ts`, `routePoints.ts`, `recentDestinations.ts`, each with a co-located test; `RequestForm.sentence.test.tsx`; the time window, REQ §13.112 c: `timeWindow.ts`(+test), `WindowSummaryLine.tsx`; the migrations `*duration_lock*`/`*window_locked*`; the solver lock is covered under the solver area, `src/solver/__tests__/durationLock.test.ts`),
`queryKeys.ts` (all under `src/features/requests/`); `src/components/RideTypeChips.tsx`(+test); `src/i18n/he.member.ts`; migrations matching
`*request_template*`, `*anchors*`, `*route_minutes_preview*`, `*classic_request_form*`, `*series*`, `*requests.sql`, `*request_edit*`, `*bulk_request_withdrawal*`,
`*child*`, `*origin*` (origins/trip_type, REQ §13.93, steps O2/O3), `*stop*` (multi-stop rides, REQ §13.93, step O6); `e2e/multi-day.spec.ts`, `repeating-requests.spec.ts`, `member.spec.ts`,
`auto-approve.spec.ts`, `upcoming-week.spec.ts`, `multi-stop.spec.ts`, `request-sentence.spec.ts`, `request-rush-hours.spec.ts` (REQ §13.113), `request-sentence-overlay.spec.ts`, `request-window.spec.ts`, `request-edit.spec.ts`, `plan-b-form.spec.ts`, `plan-b-cycle.spec.ts` (shared plumbing: `e2e/request-form.ts`);
`src/features/requests/stops.ts`(+test via `requestForm/StopsField.test.tsx`), `src/lib/routeStops.ts`, `src/lib/routeLabel.ts`(+test).

**Automated**:
- Vitest: `npx vitest run src/features/requests`
- SQL: `request_templates.sql`, `multi_day_series.sql`, `origins_schema.sql`, `origins_chain.sql`, `multi_stop.sql`, `department_rush_hours.sql` (REQ §13.113: `department_settings.rush_*` defaults, member read / no write, admin edit, CHECK refusals), `request_anchors.sql` (REQ §13.110: time anchors, shift trigger, `route_minutes_preview`, `classic_request_form`), `plan_b.sql` (REQ §13.112 a/b: `destinations.is_drop_point`, `submit_request` `fallback`/`alternative` keys + validation, `request_alternatives` RLS, the `alternative` proposal create → publish gate (`publication_alternatives_pending`, not bypassable) → send → accept → applied with the main trip kept in `original_main` and restorable, decline, a stale plan B, fairness weight 0.1, publication score weights; API twin in `scripts/test-api.mjs` section `planb`; solver `src/solver/__tests__/alternative.test.ts`), `qa_run11_noop_save.sql` (REQ §13.101 l, R11B1: a save with no changes is `unchanged` and writes nothing — open week, waitlisted/submitted/assigned on a published week; probes report it; a real change still saves; `qa_run5_publish.sql` also covers R11B3, a waitlisted-only member's `published` notice; `scripts/test-api.mjs` section `request`/`planb`: no-op resave, `alternative_car_required`), `request_window.sql` (REQ §13.112 c/d: `duration_locked`, relaxed late-flex CHECKs, `requests_duration_lock_guard`, `submit_request` keys, templates, `merge_window_locked`, unnamed children counts) (run via `npm run db:test`, all-or-nothing)
- Playwright: `npx playwright test --grep "@request-form"` (`multi-day.spec.ts`,
  `repeating-requests.spec.ts`, `member.spec.ts`, `auto-approve.spec.ts`, `upcoming-week.spec.ts`,
  `multi-stop.spec.ts`, `request-sentence.spec.ts`; `e2e/global-setup.ts` opts the seeded accounts into the classic form, the sentence specs flip one member to the sentence layout for their run and restore it)
  - REQ §13.110–§13.112 specs (written 2026-10-08): `request-sentence-overlay.spec.ts` (card over the siddur at phone + desktop width, who chip with companion + unnamed adult/child seat/booster stored as seat counts, arrive-by with derived departure, `/my` "להגיע עד", `?day=`), `request-window.spec.ts` ("יש לי חלון זמן?" 3 h between 07:00 and 12:00: stored `duration_locked`, `/my` summary, edit reopens in window mode), `request-edit.spec.ts` (no-change save toast + unchanged version; published day: a note-only edit keeps ride/status, a time change still asks), `plan-b-form.spec.ts` (sentence plan B with another pickup place, "אסתדר", switch to הקפצה uses/restores plan B or asks the dialog; classic "+ תוכנית ב׳" saves, reopens, no error before a submit attempt), `plan-b-cycle.spec.ts` (also `@board @proposals @publication`: unmet card "תוכנית ב׳ אפשרית" → proposal → publish blocked → `/p/<token>` accept → "שובצת בתוכנית ב׳" → removal also removes the pickup request; serial)

**QA script**:
0. (Sentence layout, REQ §13.110) Sign in as a member whose profile has "טופס הבקשה הקלאסי" off, open a new request: the form is one sentence of tappable chips. Pick a destination, open the outbound time chip, choose "להגיע עד" 09:30: the sheet shows "יציאה משוערת …"; submit; `/my` shows "להגיע עד 09:30". Turn the profile switch on: the old field-by-field form returns.
0b. (Time window + unnamed children, REQ §13.112 c/d) In the sentence form tap "יש לי חלון זמן?": the two time chips become "ל־4 שעות בין 08:00 ל־14:00"; set the hours to 3 and the window to 07:00–12:00, submit; `/my` shows "3 שעות בין 07:00 ל־12:00" and the stored row is the 07:00–10:00 block with 2 h later slack and `duration_locked`. Edit it: it reopens in window mode; "שעות מסוימות" switches back without losing the fixed times. In the who sheet add one מושב בטיחות and one בוסטר: the chip reads "אני ו־2 ילדים"; edit keeps them.
1. Sign in as `member1`. Go to "הבקשות שלי" → new request. Fill destination/time, tap "חזרה ביום
   אחר?" (REQ §13.77), pick a day 2 days later, submit. Expected: one request card with a 3-day
   series badge, three linked legs shown on the siddur once placed.
2. Withdraw the series request from "הבקשות שלי". Expected: all three legs cancel together
   (cascading withdraw), no orphaned leg remains on the board.
3. As `member1`, submit a request with the repeat-weekly switch left on. Next week (still `open`),
   check the request form / Home for a dismissable suggestion prefilled from the template; snooze
   it once, confirm it returns the following week; then stop repeating and confirm it disappears
   for good.
4. Submit a plain single-day round-trip request (no "חזרה ביום אחר?"); confirm a late submission
   (after the department's close time) is still accepted but flagged (REQ §13.6).
5. Add an out-stop via "+ עצירה" on a new request; confirm the chip, that "/my" shows the stop
   name in the route label, and the Sadran board's unmet card shows "· 1 עצירות" (REQ §13.93
   "Multi-stop rides").

**REQ**: §13.28, §13.45, §13.76, §13.77, §13.93.

### quick-request — Quick / car-now request

**Paths**: `src/features/requests/quickRequest.ts`(+test), `carNow.ts`(+test),
`components/QuickRequestSheet.tsx`(+test), `components/CarNowButton.tsx`(+test),
`components/RequestForm.tsx` (shared, see fan-out); `src/i18n/he.member.ts`; migrations matching
`*quick_request*`; `e2e/quick-request.spec.ts`, `quick-one-way.spec.ts`, `car-now.spec.ts` ("רוצה רכב עכשיו!" in the sentence layout).

**Automated**:
- Vitest: `npx vitest run src/features/requests/quickRequest.test.ts src/features/requests/carNow.test.ts src/features/requests/components/QuickRequestSheet.test.tsx src/features/requests/components/CarNowButton.test.tsx`
- SQL: `live_quick_one_way.sql`
- Playwright: `npx playwright test --grep "@quick-request"`

**QA script**:
1. During the live week, as `member1`, on the siddur tap "רוצה רכב עכשיו!" (only enabled while a
   shared car is free right now). Expected: a simplified sheet — destination, ride type, duration
   in whole hours (1–12, default 2), companions/children/guests, luggage, notes; no flexibility
   field, no return-time field, no one-way option; a car picker only appears when more than one
   shared car is free right now.
2. Submit it. Expected: same auto-approve behavior as any round-trip request on a free car —
   immediately assigned, no Sadran step.
3. Click an empty cell directly on the board (Sadran view) to quick-create a request in that slot;
   confirm it also goes through the same simplified path.

**REQ**: §13.74.

### waitlist — Waiting list & joinable rides

**Paths**: `src/features/waitlist/**`, `src/features/requests/joinableRides.ts`(+test),
`components/JoinableRidesDialog.tsx`, `components/RequestForm.tsx`; `src/i18n/he.member.ts`,
`he.sadran.ts`; migrations matching `*waitlist*`, `*freed_slot*`, `*joinable_rides*`,
`*join_radius*`; `e2e/waitlist-groups.spec.ts`, `freed-slot.spec.ts`.

**Automated**:
- Vitest: `npx vitest run src/features/waitlist src/features/requests/joinableRides.test.ts`
- SQL: `waitlist_groups.sql`, `joinable_rides.sql`, `withdraw_settles.sql`
- Playwright: `npx playwright test --grep "@waitlist"`

**QA script**:
1. Against a published day with no free shared car, as `member2`, submit a request. Expected
   toast/outcome: "רשימת המתנה ליום {day}" (waitlisted), and immediately after, a dialog titled
   "נכנסת לרשימת ההמתנה — אבל יש אפשרות נוספת" listing nearby existing rides (REQ §13.83) ordered
   by distance then departure time, each within `join_radius_km` and ±120 min of the request.
2. On that dialog, tap "הצטרפות לנסיעה" on an offered ride. Expected: joins that ride directly (via
   `add_ride_passengers`) and withdraws the now-redundant waitlisted request; the driver's ride now
   shows the joiner in its people list.
3. Instead tap "להישאר ברשימת ההמתנה". Expected: ordinary waitlisted outcome, unchanged.
4. As `member1`, cancel an assigned ride on the live week; confirm an overlapping waitlisted
   request from `member2` is auto-assigned to the freed slot (freed-slot matching).
5. Create two overlapping round-trip requests on a single-car published day that cannot both be
   served; confirm they form one **"בדיון: …"** contested waiting-list block, both members are
   notified, and either the Sadran or a participant can resolve it (`resolve_waitlist_group`) into
   one combined ride (first ticked = driver) or the Sadran can drop it (`cancel_waitlist_group`).

**REQ**: §13.7, §13.33, §13.66, §13.75, §13.83.

### new-request-window — New-request button & week window (incl. Sadran closing time)

**Paths**: `src/features/requests/window.ts`(+test), `resolveWeekStart.ts`(+test),
`newRequestButton.ts`(+test), `components/NewRequestButton.tsx`, `components/AddRideFab.tsx`;
`src/i18n/he.member.ts`; migrations matching `*upcoming*`, `*week_opening*`, `*window_changed*`,
`*week_close_at*`; `e2e/upcoming-week.spec.ts`.

**Automated**:
- Vitest: `npx vitest run src/features/requests/window.test.ts src/features/requests/resolveWeekStart.test.ts src/features/requests/newRequestButton.test.ts`
- SQL: `week_opening.sql`, `upcoming_weeks.sql`
- Playwright: `npx playwright test --grep "@new-request-window"` (coverage gap — see below)

**QA script**:
1. As `member1`, with no week currently `open`, view Home / tap the floating "+". Expected: it
   targets the earliest upcoming `solving`/`published` week ("next" week rule), never opens a
   quick sheet.
2. As `sadran`, from the board's kebab menu, open "שינוי מועד סגירת הבקשות" and change the week's
   close time. Expected: a `window_changed` notification reaches members without a request for
   that week; the new close time is respected by late-request flagging.
3. Confirm the "בקשה חדשה" entry point shows the right one of its three/four states depending on
   the target week's phase (REQ §13.81) — e.g. against a published week it reads "רשימת המתנה
   לשבוע הבא" and links to the request form for that week.

**Coverage gap** (per `docs/E2E_AUDIT_2026-09-14.md`): no spec clicks the actual `NewRequestButton`
to assert its label/state per phase, and no spec opens "שינוי מועד סגירת הבקשות" — every existing
spec navigates to `/requests/new` directly by URL. Treat steps 1–2 as **manual-only** until that
gap is closed.

**REQ**: §13.74, §13.81.

### siddur — Siddur (member week view)

**Paths**: `src/features/siddur/**`, `src/components/WeekGrid.tsx`(+tests), `weekGridCars.ts`(+test),
`WeekStrip.test.tsx`, `src/pages/SiddurPage.tsx`; `src/i18n/he.member.ts`; migrations matching
`*public_request*`, `*public_notes*`, `*car_swap*`, or whose content defines `v_board_rides`;
`src/components/CarSwapDialog.tsx`(+test), `WeekGrid.carSwap.test.tsx`, `src/features/carSwap/**`;
`e2e/siddur-mobile.spec.ts`, `siddur-desktop.spec.ts` (REQ §13.111 b: week switcher + car names without sideways overflow at 1280 px), `ride-editing.spec.ts`, `member.spec.ts`, `car-swap.spec.ts`, `car-handover.spec.ts` ("be back on time" note);
`src/features/rides/servedOf.ts`, `src/features/rides/components/RideRouteStops.tsx`,
`src/lib/routeStops.ts` (multi-stop rides ride-detail route display, REQ §13.93, step O6).
`src/features/rides/carHandover*`, `components/CarHandoverNotice.tsx`, `components/RideCarHandover.tsx`, `src/features/requests/rowHandover*`,
migrations `*ride_car_neighbours*`, `supabase/tests/car_handover_notes.sql` ("be back on time" note, REQ §13.108 f).

**Automated**:
- Vitest: `npx vitest run src/features/siddur src/features/rides/carHandover.test.ts src/features/requests/rowHandover.test.ts src/components/WeekGrid.test.ts src/components/WeekGrid.gestures.test.tsx src/components/weekGridCars.test.ts`
- SQL: `selected_day_publication.sql`, `day_car_swap.sql`, `car_handover_notes.sql`
- Playwright: `npx playwright test --grep "@siddur"`

**QA script**:
1. As `member1`, open the published/live week's siddur. Use the title switcher to change weeks,
   toggle the eye menu's table view, and confirm the archive lists a past week read-only.
2. Confirm a **private/temporary car's row is shown only on days it actually has a ride** (REQ
   §13.80) — pick a day with no ride on a private car and confirm its row is simply absent; a
   shared car's row stays even with no ride that day.
3. Confirm sliding labels (day/time) render correctly at phone width (412×915) and desktop.
4. As `member2` viewing another department's published siddur (read-only, lift-finding, REQ
   §13.52), confirm car names show but no lockbox code (§13.79), and no draft/unpublished data.
5. Resize an owned ride on an already-published day; confirm a shadow-collision prompts explicit
   driver consent rather than silently overwriting another ride.
6. Drag one car's header onto another's for a published, non-past day; confirm the confirmation
   dialog lists what moves, the swap succeeds, and everyone but you gets notified (REQ §13.92).
7. Give a ride on a published day a follow-up ride on the same car (another member, a Sadran
   reservation or a car move) starting within the week's turnaround (never under 30 minutes) after
   it ends: the driver/requester sees an amber "!" line on `/my`, the Home card and the ride sheet
   ("X takes the car at HH:MM — return on time"); the next ride's driver sees "the car arrives from
   X's ride at HH:MM". Nothing shows for an unpublished next day, a cancelled ride, the member's
   own next ride or the next day of the same multi-day request (REQ §13.108 f). No e2e spec yet —
   covered by `car_handover_notes.sql`, the API suite and unit tests.

**Coverage gap**: no spec directly asserts the private-car-hidden-on-idle-days behavior on either
grid (item 2) — `hideIdleTemporaryCars()` is unit-tested in `weekGridCars.test.ts` but not via e2e.

**REQ**: §13.42, §13.56, §13.80, §13.92, §13.108.

### board — Board (Sadran): drag/drop, reservations, policy chip/score

**Paths**: `src/features/sadran/board/**`, `applySolve.ts`(+test), `unmetStatuses.ts`(+test),
`deviations/**`, `export/**`, `api.ts`, `hooks.ts`, `keys.ts`; `src/components/WeekGrid.tsx`,
`weekGridCars.ts`; `src/solver/**` (shared fan-out); `src/i18n/he.sadran.ts`; migrations matching
`*board*`, `*coordinator*`, `*ride_edit*`, `*day_readiness*`, `*car_chain*`, `*car_swap*`, or
content-matching `v_board_rides`/`publish_siddur`; `src/components/CarSwapDialog.tsx`(+test),
`WeekGrid.carSwap.test.tsx`, `src/features/carSwap/**`; `e2e/board.spec.ts`, `board-mobile.spec.ts`,
`board-coordination.spec.ts`, `board-drafts.spec.ts` (REQ §13.94 drafts), `merged-ride.spec.ts` (REQ §13.94 merged ride = one block, unmerge), `merge-verdict.spec.ts` (REQ §13.108 e: merge popup takes the server's `merge_preview` verdict), `pilot-p2-trip-type-placement.spec.ts` (REQ §13.117: an unmet request changed to a drop-off is placed on a free car), `export.spec.ts`, `weekly-permissions.spec.ts`, `ride-editing.spec.ts`, `large-trunk-waiver.spec.ts` (REQ §13.111 a: confirm/decline the small-car waiver on a hand drop), `plan-b-cycle.spec.ts`,
`car-swap.spec.ts`, `multi-stop.spec.ts`, `live-changes.spec.ts` (REQ §13.118: a pending merge keeps the host ride editable, a volunteer driver is replaced in one step); `src/features/rides/servedOf.ts`,
`src/features/rides/components/RideRouteStops.tsx`, `src/lib/routeStops.ts` (multi-stop rides
display, REQ §13.93, step O6); `src/features/rides/components/RideRoute.tsx`, `src/lib/rideRoute.ts`(+test) (ride route twin and display, REQ §13.94); `src/lib/weekSettings.ts`(+test) (week turnaround/dwell override, REQ §13.108 a).

**Automated**:
- Vitest: `npx vitest run src/features/sadran/board src/features/sadran/applySolve.test.ts src/features/sadran/unmetStatuses.test.ts src/features/sadran/deviations src/features/sadran/export src/lib/rideRoute.test.ts src/lib/weekSettings.test.ts`
- SQL: `p4_live_changes.sql` (REQ §13.118: a member cancelling a chauffeur ride frees its car; replace a volunteer driver), `todo_board_semantics.sql`, `coordinator_planning.sql`, `solve_semantics.sql`, `car_chain_healing.sql`, `day_car_swap.sql`, `origins_chain.sql`, `qa_run1_proposals.sql`, `qa_run1_cancel_waitlist.sql` (QA run 1 fixes: proposals/merges/chain, cancellation/waiting list/status), `placement_features.sql` (REQ §13.101: luggage needs a large trunk, set_ride_driver, duplicate withdraw/restore, own-car placement, published-day edit, freed car to the contested group), `week_settings_source.sql` (REQ §13.108 a/b: week turnaround override, 60-minute unknown travel), `luggage_waiver.sql` (REQ §13.111 a: every manual placement path refuses with `needs_large_trunk` without `allow_small_trunk` and waives with it; merge_preview waivable verdict; waived request moves/merges/swaps later; automatic paths stay strict; editing luggage clears the waiver); Vitest `src/lib/smallTrunk.test.ts`, `src/lib/luggageWaiver.test.ts`
- Playwright: `npx playwright test --grep "@board"`

**QA script**:
1. As `sadran`, open the board for the `open`/`solving` week. Drag an unmet round-trip request
   onto a car column; confirm a ride is created there and the unmet count drops.
2. Run "auto-solve remaining" (kebab menu); confirm rides are placed and the policy chip shows
   "{policy name} · גרסה {n}" with a live score percentage.
3. Move a ride to another car via the sheet's car selector; confirm it persists after reload.
4. Confirm a private/temporary car's board row is likewise hidden on days it has no ride (REQ
   §13.80, same rule as the siddur).
5. As a weekly-assigned member (not permanent Sadran), confirm board access is limited to their
   assigned week only; a permanent Sadran retains access to all weeks.
6. Download the week as an Excel workbook from the kebab menu; confirm the three sheets (בקשות /
   סידור / ניקוד בפרסום).
7. Remove the return leg of a relay pair (or the out leg from under a standing return leg);
   confirm the edit succeeds and the remaining leg becomes a standalone chauffeur ride (needs a
   driver) with no relocation ride created — or, if no car is free at either end, the request
   goes back to the unmet list (REQ §13.93, 2026-10-04 — supersedes the relocation-ride
   behaviour of §13.89). Claim the chauffeur ride as a volunteer; confirm a later matching leg
   re-pairs both into ordinary relay legs.
8. As the Sadran, drag one car's header onto another's on an unpublished day; confirm the swap
   applies with no notifications, and that a multi-day series leg offers "whole ride" vs "only
   this day" (REQ §13.92).
9. Open a ride sheet for a ride whose request declared stops; confirm the route-per-leg section
   with estimated times, and that an unmet/placed card shows "· N עצירות" only when N > 0 (REQ
   §13.93 "Multi-stop rides").
10. Drag an unmet request with "ציוד רב" onto a car without a large trunk; confirm "צריך תא מטען גדול ...
    לשבץ בכל זאת?", that "ביטול" places nothing and "לשבץ בכל זאת" places it, and that its card then
    reads "ציוד רב — ויתור על תא מטען גדול" (REQ §13.111 a). Repeat with moving a ride that carries
    such a request, a merge onto a small car (popup note, then the confirmation on send/draft) and a
    car swap that would put it on a small car.
11. (REQ §13.118) Click a block marked "· מאוחד" whose proposal was sent: the host ride's own sheet opens with the banner "ממתינה תשובה על צירוף של …"; change the driver or times there; "פתיחת ההצעה" opens the proposal. On a ride with a volunteer driver, pick another member under "החלפת הנהג/ת המתנדב/ת": the driver changes in one step. Drag one day of a placed multi-day request to another car: confirm moves every day; a car busy on any day refuses and nothing moves.

**REQ**: §13.42, §13.80, §13.84, §13.89, §13.92, §13.93, §13.111, §13.118.

### proposals — Proposals & /p/:token

**Paths**: `src/features/proposals/**`, `src/features/sadran/proposals/**`,
`supabase/functions/answer-proposal/**`; `src/i18n/he.sadran.ts`, `he.member.ts`; migrations
matching `*proposal*`; `e2e/proposal.spec.ts`, `proposal-retry.spec.ts`, `board-coordination.spec.ts`, `board-drafts.spec.ts`, `merged-ride.spec.ts`,
`one-way-consent.spec.ts`, `sadran.spec.ts`, `plan-b-cycle.spec.ts` (REQ §13.112 a/f: the `alternative` proposal, its token page and application).

**Automated**:
- Vitest: `npx vitest run src/features/proposals src/features/sadran/proposals`
- SQL: `proposal_day_boundary.sql`, `proposal_replacement.sql`, `withdraw_settles.sql`
- Playwright: `npx playwright test --grep "@proposals"`

**QA script**:
1. As `sadran`, from the board, drag a request beyond its declared flexibility to create a shift
   proposal; open "פרטי ההצעה ווואטסאפ" and confirm the WhatsApp deep link text/phone are correct.
2. Open the sent proposal's `/p/<token>` link in a fresh browser context with **no session**;
   confirm it answers without sign-in and the response is binary (accept/decline only — no
   counter-proposal, no free-text note, REQ §13.46).
3. Decline via the "found another solution" (`external`) path and opt out of freed-slot offers for
   that week; confirm the Sadran sees `proposal_answered` (only the sender, not every Sadran on
   duty — REQ §13.67).
4. Attempt to create a Sadran-composed merge proposal on an already-**published** day; confirm it
   is refused (`proposal_day_public`) — only `ask_to_join` proposals are exempt.
5. Resend/replace a sent proposal's token; confirm the old token is revoked.

**REQ**: §13.24, §13.29, §13.46, §13.67.

### ride-passengers — Ride passengers (one list per ride)

**Paths**: `src/lib/ridePassengerSummary.ts`(+test), `ridePublicDetails.ts`(+test),
`src/features/rides/ridePeople.ts`(+test), `addPassengers.ts`(+test), `api.ts`, `hooks.ts`, `keys.ts`,
`components/AddPassengersDialog.tsx`, `RidePassengersList.tsx`, `RidePublicNotesEditor.tsx` (moved from siddur, R8);
`src/features/siddur/components/RideDetailSheet.tsx`;
`src/features/sadran/board/reservationPeople.ts`(+test), `components/RidePassengersEditor.tsx`,
`RideSheet.tsx`; `src/features/requests/components/JoinableRidesDialog.tsx`; `src/i18n/he.member.ts`,
`he.sadran.ts`; migrations matching `*ride_passenger*`, `*ride_people*`, `*unified_ride_people*`;
`e2e/board.spec.ts` (free-text reservations).

**Automated**:
- Vitest: `npx vitest run src/lib/ridePassengerSummary.test.ts src/lib/ridePublicDetails.test.ts src/features/siddur/ridePeople.test.ts src/features/siddur/addPassengers.test.ts src/features/sadran/board/reservationPeople.test.ts`
- SQL: `ride_passengers.sql`
- Playwright: `npx playwright test --grep "@ride-passengers"` (coverage gap — see below)

**QA script**:
1. As `sadran`, create a manual reservation ("שמירת זמן") and name a department member plus a
   child on it; confirm the first named person becomes the driver, and that person sees the ride
   in their own "my rides" and gets notified (`outcome_changed`/`reservation_added`).
2. Open a ride's people list (either on the board's `RideSheet` or the siddur's
   `RideDetailSheet`); confirm requester, companions, named children, guest names and any directly
   added (`ride_passengers`) people all appear in **one** list, ordered driver-first then by name,
   with no visual distinction between "filed via request" and "added directly" (REQ §13.85).
3. Cancel the ride fully; confirm every listed person (not just the driver) gets a cancellation
   notice with day/time/destination/car and who cancelled (REQ §13.68).

**Coverage gap**: no spec opens the "+ נוסעים" dialog on either sheet, and no spec names people on
a manual reservation — `board.spec.ts`'s "free-text reservations" test only covers the
no-named-people path (per `docs/E2E_AUDIT_2026-09-14.md`).

**REQ**: §13.82, §13.85.

### publication — Publication & scores

**Paths**: `src/features/sadran/publish/**`, `lastUsedPolicy.ts`(+test); `src/solver/**` (shared
fan-out); `src/i18n/he.sadran.ts`; migrations matching `*publish*`, `*siddur_version*`,
`*publication*`, or content-matching `v_board_rides`/`publish_siddur`; `e2e/sadran.spec.ts`,
`waitlist-groups.spec.ts`, `export.spec.ts`, `plan-b-cycle.spec.ts` (publishing waits for a pending plan-B proposal), `publish-autofill-series.spec.ts` (REQ §13.115: per-day autofill places a whole series; the picker pre-ticks only solved days).

**Automated**:
- Vitest: `npx vitest run src/features/sadran/publish src/features/sadran/lastUsedPolicy.test.ts`
- SQL: `selected_day_publication.sql`, `board_drafts.sql` (draft proposals block publishing, discard/withdraw RPCs, re-solve keeps draft merge hosts), `merged_rides.sql` (ride route, merge apply window, `unmerge_request`, shift places/stops, manual handover), `proposals_copy_and_series_span.sql` (REQ §13.101: per-reader proposal/outcome copy, joined-ride notices, `series_span` fewer days, large-luggage merge refusal), `qa_run2_proposals.sql` (REQ §13.102: pending proposal answerable across publication, impossible one withdrawn + Sadran told, merge reason codes, split merge on two rides, no empty/non-change copy, external-accepted notice, placed -> external withdrawn, publish notice per changed ride old -> new), `qa_run3_proposals.sql` (REQ §13.103: a driver assigned to the host never makes an accepted merge stale, members who accepted are told when it falls through, return-only merge copy/preview stop time, split merge through a sent proposal extended by the other leg, old -> new in shift/merge texts), `qa_run4_proposals.sql` (REQ §13.104: one time source for a merge — `merge_preview` joiner times = the joiner's text = the host's window, the joiner keeps own stops and learns where the ride continues, old -> new + added minutes in every proposal title, no-driver copy, expired proposal answers `proposal_expired`), `qa_run5_proposals.sql` (REQ §13.105: a one-leg shift places only that leg, a member's notice never links a Sadran page, an accepted external resolves every unplaced leg of a series, a car at the same times is not "if we move", `join_drop_off_legs` by hand, fewer days down to a single day), `p3_notices.sql` (REQ §13.116, pilot fix round P3: no outcome notice before a day is published — the `enqueue_notification` gate; an ask-to-join on a private car is sent to its owner; the driver of a shared ride is told on an ask-to-join; fellow passengers told when one leaves; `proposal_viewer_merge` per reader; non-driver merge copy), `e2e/proposal-merge-view.spec.ts` (the `/p` page per reader of a merge with the server's `merge` block stubbed; external buttons), `qa_run5_publish.sql` (REQ §13.105 e: readiness counts external/denied as answered and accepted external proposals as not pending, the `published` notice lists one line per ride with pickups and without external legs under a title naming the member's days, notice dates/times carry the weekday, `ask_to_join` notice variants)
- Playwright: `npx playwright test --grep "@publication"`

**QA script**:
1. As `sadran`, open `/publish` for a `solving` week with unanswered proposals/missing drivers.
   Expected: **actual conflicts** on the selected days block publishing; unanswered
   requests/proposals and missing drivers require explicit confirmation instead ("Only ready days"
   excludes them). Click the collision count and confirm it cycles through affected rides.
2. Publish specific days only (`p_days`); confirm siddur/board/proposals treat only those days as
   public — a proposal can still be created for an unpublished day of the same week.
3. Confirm publishing settles leftovers: every still-unresolved round-trip request that a free
   shared car can take is auto-approved, and whatever's left clusters into contested waiting-list
   groups (REQ §13.75) rather than sitting first-come-first-served.
4. Confirm the diff/version screen shows "גרסה {n}" history and a "סיכום השינויים מהגרסה הקודמת".

**REQ**: §13.47, §13.66, §13.75.

### solver — Solver (placement, mileage/carChoice, suggestions)

**Paths**: `src/solver/**`, `src/features/solverBridge/**`, `supabase/functions/on-ride-cancelled/**`;
migrations matching `*polic*`, `*fairness*`, `*mileage*`, `*apply_solver_result*`, `*pair_one_way_legs*`,
`*route_minutes*`, `*route_helpers*` (route minutes/km for multi-stop legs, REQ §13.93, step O6);
`supabase/tests/fixtures/one_way_pairing_cases.json` + `scripts/test-pairing-parity.mjs` +
`src/solver/__tests__/oneWayPairingParity.test.ts` (one-way pairing golden cases, run against both the
solver and SQL `pair_one_way_legs`; the SQL side is the last step of `db:test`); `supabase/tests/multi_stop.sql`;
`e2e/auto-approve.spec.ts`, `freed-slot.spec.ts`, `board.spec.ts`; `scripts/qa/**` (the QA simulation: week generator,
real-solver regression, QA CLIs — docs/QA_SIMULATION.md).

**Automated**:
- Vitest: `npx vitest run src/solver src/features/solverBridge`
- SQL: `solve_semantics.sql`, `car_mileage.sql`, `multi_stop.sql`
- Playwright: `npx playwright test --grep "@solver"` (indirect coverage only — the solver itself is
  pure and has no UI of its own; these specs exercise it end to end)
- **Extended (opt-in, disposable stack only):** `npm run qa:regression -- --seed 7` (or `QA_REGRESSION=1 QA_API_URL=<disposable api> npm run db:test`) generates the seeded QA week, solves it with the real solver, applies it as the QA Sadran and checks the invariants (docs/QA_SIMULATION.md §5). CI's database job runs it as a non-blocking "Extended" step.
- **API-level (docs/TODO.md U1/U1a; disposable stack only, and always on in CI's database job via `QA_API=1`):** `node scripts/test-api.mjs` (or `QA_API=1 QA_API_URL=<disposable api> npm run db:test`) drives real RPCs as signed-in seeded users through PostgREST: cancel as passenger / chauffeur requester / driver (R5B1); member `submit_request` -> edit with `expected_version` -> `withdraw_request`; Sadran `create_proposal` (merge, shift) -> `send_proposal` -> members `answer_proposal` in-app -> applied; `publish_siddur` then a plain member reads the rides (RLS); member `add_ride_passengers`/`remove_ride_person` and `swap_day_cars`; Sadran `mark_car_move`, `set_ride_driver`; freed slot (`cancel_ride` -> `resolve_freed_offer` -> `claim_freed_slot` -> `approve_claim`, lone-candidate auto assign); `submit_series_request` -> `shorten_series`; per-role negatives (a member cannot publish, propose, send, approve, move a car, assign a driver). Fixtures use random far-future weeks; a published week keeps its immutable `siddur_versions` row. Every server-side QA bug gets a case here. `supabase/tests/qa_run5_cancel.sql` (REQ §13.104: R5B1 cancel as non-driver, R5B7 volunteer-driver notices, R5B10 accepted-then-withdrawn proposal on a driverless ride notifies member + Sadran).
- **After any change under `src/solver/**`**: `npm run functions:bundle` (CI diff-checks
  `supabase/functions/_shared/solver.js` against the source).

**QA script**:
1. As `sadran`, run the solver on an `open` week with several competing requests; confirm the
   admin-editable priority policy weights change the resulting order (policy score visible on the
   board and in the priority-policy admin screen — "מדיניות דירוג הבקשות").
2. Confirm mileage/carChoice balancing (REQ §13.84): when two shared cars are otherwise tied for a
   request, the solver prefers the one with lower rolling 4-week + this-solve mileage; confirm this
   never overrides preferred car/seat fit/availability/usual car, and never forces a manual move —
   it only shows as a visible reason on the assignment.
3. Confirm a relay pair, a merge, and a split-legs suggestion each produce the correct proposal
   type (shift / merge / external / deny) per SOLVER §3.15.
4. Confirm the solver never displaces an already-placed ride automatically (only as a
   before-publish suggestion) and that `matchFreedSlot` / `try_auto_approve` never displace either.

**REQ**: §13.5, §13.14, §13.16–§13.24, §13.58, §13.63–§13.65, §13.84.

### notifications — Notifications & push

**Paths**: `src/features/inbox/**`, `src/pages/InboxPage.tsx`, `src/lib/notificationEvents.ts`(+test) (event metadata mirror of SQL `notification_event_meta`), `src/lib/push.ts`, `src/sw.ts`, `src/i18n/he.ts` and `supabase/seed.sql` (notification copy / template rows),
`supabase/functions/push-dispatch/**`; `src/i18n/he.member.ts`; migrations matching
`*notification*`, `*notify_*`, or content-matching `enqueue_notification`; `e2e/device-setup.spec.ts`.

**Automated**:
- Vitest: `npx vitest run src/features/inbox`
- SQL: `notifications_semantics.sql`, `status_notifications.sql`
- Playwright: `npx playwright test --grep "@notifications"` (real push delivery is manual-only per
  `.claude/agents/e2e-tester.md` — specs assert the inbox row / template text, not a real push)

**QA script**:
1. As `member1`, trigger any of the 24 canonical events (e.g. submit late → "flagged" notice, or
   have `sadran` send a proposal) and confirm an inbox row appears with the seeded template's
   title/body and the correct deep link (`notification_default_url()`).
2. Mute a category in profile settings; confirm that event no longer creates an inbox row for that
   member (Sadran-role events stay unmutable while assigned).
3. Confirm a full ride cancellation notifies **every** served member individually, not just whoever
   cancelled (REQ §13.68), and `proposal_answered` reaches only the sender (`proposals.created_by`,
   REQ §13.67).
4. On a supported device, dismiss the home-screen install prompt and confirm it does not reappear
   on refresh (device-setup flow feeding push permission).

**REQ**: §13.30, §13.41, §13.61, §13.67, §13.68.

### stats — Statistics

**Paths**: `src/features/stats/**`; `src/i18n/he.admin.ts`, `he.sadran.ts`; migrations matching
`*stats*`. No dedicated Playwright spec exists yet (see coverage gap).

**Automated**:
- Vitest: `npx vitest run src/features/stats`
- SQL: `department_stats.sql`
- Playwright: none yet — **manual-only** until a spec is added.

**QA script**:
1. As `admin` or `sadran`, open "סטטיסטיקה" and pick a date range (capped at 400 days, inclusive
   Jerusalem-calendar). Confirm the five metrics render: utilization ("שיעור ניצולת"), sharing
   tiles, same-day-cancellation tile, hour-of-day bar list, weekday bar list.
2. Confirm the ride-type pie and weekly-unmet chart match what the seeded/fake-week data would
   produce (cross-check against `department_stats.sql`'s fixtures if in doubt).
3. Confirm policy score by week appears once a week has been published with scores.

**Coverage gap**: `docs/E2E_AUDIT_2026-09-14.md` item 6 — no spec visits the stats screen at all.

**REQ**: §13.78.

### admin — Admin catalogs (cars, destinations, ride types, policies, settings, members, departments)

**Paths**: `src/features/admin/**`, `src/features/fleet/**`, `src/features/diagnostics/**` (client errors, `/admin/errors`),
`supabase/functions/destination-route/**`; `src/i18n/he.admin.ts`; migrations matching `*admin*`,
`*catalog*`, `*member_identity*`, `*department_membership*`, `*origin*`, `*place_distances*`
(cars' base location / members' default origin / `place_distances`, REQ §13.93, steps O2/O3);
`e2e/admin.spec.ts`, `admin-department.spec.ts`, `admin-errors.spec.ts`, `department-context.spec.ts`, `destinations-drop-points.spec.ts` (REQ §13.112: the "נקודת הקפצה" switch and column, admin and Sadran).

**Automated**:
- Vitest: `npx vitest run src/features/admin src/features/fleet src/features/diagnostics`
- SQL: `admin_member_fixes.sql`, `admin_department_membership.sql`, `department_catalogs.sql`,
  `member_identity.sql`, `origins_schema.sql`
- Playwright: `npx playwright test --grep "@admin"`

**QA script**:
1. As `admin`, from "ניהול מחלקות, חברים, רכבים, יעדים ומדיניות העדיפויות", create a car with a
   seat config, a destination, and a policy version; confirm each shows up in its list/history tab.
2. Edit a member's details and assign them as a weekly (non-permanent) Sadran; confirm the
   distinction from a permanently-promoted Sadran (REQ §13.9's driver-is-requester default,
   permissions scoped correctly).
3. As `admin`, join/leave a department through the member editor; confirm display name vs Google
   name behavior.
4. As `member1`, switch the department context selector to a department they don't belong to;
   confirm it's read-only (catalogs/Maps route estimates require the owning department).
5. As `admin`, open `/admin/errors` ("שגיאות באפליקציה"): the list shows recent browser errors
   (time, user, version, page, expandable stack); a member cannot open the route.

**REQ**: §13.2, §13.8, §13.25.

### car-care — Car care

**Paths**: `src/features/carCare/**`, `src/features/cars/**`; `src/i18n/he.member.ts` (`carCare.*`,
`carPage.*`), `he.admin.ts`; migrations matching `*car_care*`, `*car_issue*`, `*car_responsible*`;
`e2e/car-care.spec.ts`.

**Automated**:
- Vitest: `npx vitest run src/features/carCare src/features/cars`
- SQL: `car_care_semantics.sql`
- Playwright: `npx playwright test --grep "@car-care"`

**QA script**:
1. As `member1`, from a car's page report a problem ("דיווח על תקלה"), choosing a category (אור
   אזהרה / תקלה מכנית / תקלת תאורה / נזק לרכב) and description; confirm "תודה, הדיווח נשלח
   לאחראי/ת הרכב" and that the car's responsible person (or, absent one, every admin) sees it.
2. Log a tire fill ("מילאתי אוויר בצמיגים") across all five positions (front-left/right,
   rear-left/right, spare) with a 3-state legend (תקין / הוספתי 2–5 PSI / הוספתי מעל 5 PSI);
   confirm all five are required.
3. Log a wash ("שטפתי את הרכב"); confirm the celebration toast and a history row.
4. As the car's responsible person or `admin`, open "היסטוריה" on the car page, filter by
   date/kind, and export to Excel ("ייצוא לאקסל"); confirm the exported sheet matches the filtered
   history.

**REQ**: §13.69, §13.70, §13.71, §13.72, §13.73.

### maintenance — Scheduled car maintenance

**Paths**: `src/features/fleet/**` (`maintenance.ts`, `MaintenancePeriodDialog`, `CarMaintenancePanel`,
`useMaintenanceGridEditing`), `admin/cars` `MaintenanceScreen`/`IssuesScreen`, `WeekGrid` bands;
migrations matching `*maintenance*`; `supabase/tests/scheduled_maintenance.sql`; `e2e/maintenance.spec.ts`.

**Automated**:
- Vitest: `npx vitest run src/features/fleet src/components/WeekGrid.maintenance.test.tsx`
- SQL: `scheduled_maintenance.sql`, `department_isolation.sql`; API: `QA_API=1 npm run db:test` (section "maintenance")
- Playwright: `npx playwright test --grep "@maintenance"`

**QA script**:
1. As the car's responsible member open the car page: "טיפול הבא" line; "תקופת טיפול" → a period over several days.
2. On the siddur (wide screen / table view) and on the board the period is a hatched band in the car's
   column, with no icon. Responsible member, Sadran and admin drag it, resize by the top/bottom handle
   or click it; another member sees it read-only.
3. Extend a period over a booked ride: the ride is flagged, the driver and the Sadran are notified;
   shorten it back: the flag clears.
4. `/admin/issues`: "העבר לטיפול" on an issue asks for the end only (start = now); `/admin/cars` shows
   "טיפול הבא".
5. In a live week request a ride at a time a car is inside a period: never placed on it.

**REQ**: §6.3, §13.114.

### auth — Auth / onboarding / roles

**Paths**: `src/features/auth/**`; the shell and landing (`src/app/router.tsx`, `AppShell.tsx`,
`landing.ts`(+test), `LandingRedirect.tsx`, `routes.ts`(+test), `src/features/member/routes.tsx`, `lazyPages.ts`, `src/pages/LoginPage.tsx` — REQ §13.87/§13.91); migrations matching `*identity*`,
`*weekly_sadran_permissions*`; `e2e/auth.spec.ts`, `device-setup.spec.ts`,
`weekly-permissions.spec.ts`, `smoke.spec.ts`.

**Automated**:
- Vitest: `npx vitest run src/features/auth src/app`
- SQL: `weekly_sadran_permissions.sql`
- Playwright: `npx playwright test --grep "@auth"`

**QA script**:
1. Sign in via "התחברות עם Google" (or the local dev email/password form) as a seeded member;
   confirm the landing is the published siddur on a first visit (and the last opened of siddur /
   my rides afterwards — same for a Sadran/admin, REQ §13.87) with the four bottom tabs (הסידור / הבקשות שלי / הודעות / פרופיל), plus a
   fifth Sadran tab while assigned.
2. Attempt sign-in with an email not on the `member_invites` allow-list; confirm the "ממתין לאישור"
   page appears, promising no email — check back or ask the Sadran (REQ §13.13/§60).
3. Confirm a weekly-assigned Sadran only manages their assigned week/board, while a permanent
   Sadran retains access to all weeks and operational settings.

**REQ**: §13.13, §13.25.

### edge-functions — Edge functions

**Paths**: `supabase/functions/**` (`push-dispatch`, `answer-proposal`, `on-ride-cancelled`,
`destination-route`, `_shared` bundled solver).

**Automated**:
- Vitest: none directly (edge functions run on Deno) — `npm run functions:bundle` bundles
  `src/solver` and runs `supabase/tests/bundle_solver.test.mjs` (a plain-Node/Deno smoke test, not
  Vitest).
- SQL: exercised indirectly through the suites that call these functions
  (`notifications_semantics.sql` for push-dispatch shape, `solve_semantics.sql` /
  `one_way_lifecycle.sql` for on-ride-cancelled).
- Playwright: no dedicated tag — see the area whose flow calls the function (**notifications** for
  `push-dispatch`, **proposals** for `answer-proposal`, **solver**/**waitlist** for
  `on-ride-cancelled`, **admin** for `destination-route`).

**QA script**:
1. After any edge function change, run `npm run functions:serve` locally and smoke-test its one
   flow (e.g. cancel an assigned ride and confirm `on-ride-cancelled` fires the freed-slot match).
2. Confirm `/p/<token>` answering (`answer-proposal`) still needs no sign-in.
3. Confirm `npm run functions:bundle` was run and the bundle diff is committed if `src/solver`
   changed.

**REQ**: §13.35, §13.36, §13.37.

### rls-security — RLS / security

**Paths**: `src/integrations/supabase/types.ts`, `src/lib/rpc.ts`, `src/lib/enums.ts`(+test), `scripts/test-db.mjs`; migrations matching `*rls*`, `*helpers*`, `*secure*`, `*grant*`, `*protect*`, `*guard*`,
`*access_code*`, `*permission*`, `*revoke*`, `*department_scope*`, `*status_department_guard*`; `supabase/schema-current.sql` (generated); `eslint.config.js`.

**Automated**:
- Vitest: none directly (enforced by ESLint rules — `no-restricted-syntax`/`-imports`/`-globals` in
  `eslint.config.js`, covered by `npm run lint`).
- SQL: `rls_smoke.sql` (every table has forced RLS, no `using (true)` on writes, no `for all`
  policies, TEST 14 checks function grants, TEST 18 pins every column of the tables readable
  across departments), `hardening_semantics.sql`, `qa_run2_placement.sql` (REQ §13.102 placement: free-gap offers, partial-leg freed-slot placement, chain flags, probe_only, one late notice, child overlaps), `qa_run6_car_location.sql` (QA run 6 group F: trip-type change only where the car is, driverless car move decides location, a chauffeur-leg move keeps its shape, fewer days to the last day sends real times), `qa_run5_placement.sql` (REQ §13.105 placement: chauffeur ride at the car's own place, pickup from X on a car standing at X as one relay ride, short contested wait connects), `qa_run4_placement.sql` (REQ §13.104 placement: manual הקפצה connect, relay-pair demand guard, short drop-off + pickup in one ride, chauffeur pickup drive, driverless rides flagged, one-leg cancel, placed count), `qa_run3_placement.sql` (REQ §13.103: car move, series shortening, passenger-left notice, busy volunteer, placed-late notice, ask-to-join, connected הקפצה vs demand, no unservable groups, machine-code refusals), `department_isolation.sql` (every browser-facing
  SECURITY DEFINER RPC called as department A with department B's ids must refuse; fails on an
  unclassified new RPC; `requests` status guard incl. a signed-in second party declining a proposal)
- Playwright: no dedicated tag — RLS gaps normally surface as a 403/permission-denied inside
  whichever area's own spec exercises the affected table/RPC.

**QA script**:
1. After any RLS/grant change, run `npm run db:test` and specifically watch `rls_smoke.sql`,
   `hardening_semantics.sql` and `department_isolation.sql` output. A new RPC must be classified in
   `department_isolation.sql`; a new column on a cross-department-readable table in TEST 18.
2. As a member of a different department, confirm you cannot read another department's draft data,
   only its published siddur (read-only, REQ §13.52), and confirm lockbox codes stay
   department-scoped (REQ §13.79).
3. Confirm phone numbers reach the client only through `phone_of()`/`profile_phones()` rules (own /
   admin / Sadran / shares a ride) — never a plain `select` on `profiles.phone` (except
   `joinable_rides_for_request()`'s deliberate `driver_phone` exposure, REQ §13.83).
4. Confirm an admin cannot delete rides/requests from the client — only cancel/withdraw.

**REQ**: §13.4, §13.79.

## Known coverage gaps (do not silently "fix" — flag to QA as manual-only)

Carried over from `docs/E2E_AUDIT_2026-09-14.md`, still true as of this writing:

- **new-request-window**: no spec clicks the actual `NewRequestButton` to assert its per-phase
  label/state; no spec opens "שינוי מועד סגירת הבקשות".
- **stats**: no spec visits the stats screen at all.
- **ride-passengers**: no spec names people on a manual reservation or opens the "+ נוסעים" dialog.
- **siddur** / **board**: no spec directly asserts the private-car-hidden-on-idle-days rule (unit
  tested in `weekGridCars.test.ts`, not e2e).

When one of these gaps is closed with a new spec, update this file's QA script (mark the step as
automated) and add the new spec + tag to `test-map.json` in the same change.
