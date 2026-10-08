# Request form overhaul — plan (2026-10-07)

Status: **stage 1 (sentence form) approved 2026-10-07 and in progress** — see "Second round" below; stage 2 (plan B, window mode, drop points) not started. Supersedes the one-paragraph TODO item OR1 (docs/TODO.md "Owner requests 2026-10-07"). Once the owner picks a layout, the chosen design moves into REQUIREMENTS (new §13 item) and UX_FLOWS §3.4 / §18 before any code.

Mockups: three clickable Hebrew variants (A sentence, B steps, C timeline), published as one private artifact page; link in the hand-over message.

## 0. Owner decisions (2026-10-07)

| # | Decision |
|---|---|
| D1 | A request may carry **one alternative ("תוכנית ב׳"), and it is always a הקפצה**: "if I don't get a car, drop me at <a drop point> by <time>, pick me up from there at <time>". |
| D2 | The solver tries the main request first and falls back to the alternative; the Sadran may pick either. Serving the alternative **is a proposal the member answers** (not an automatic placement), and it **counts less for fairness** than serving the main request. |
| D3 | Some places are marked as **drop points** (junctions, stations, common close-by places). The alternative's place list is that subset; free text still allowed. |
| D4 | Each end of the trip has its own **anchor**: the outbound is "leave home at" *or* "arrive there by"; the return is "leave there at" *or* "be home by". Example: meeting at 10:00 → "arrive by 9:30", whatever the departure; "home by 12:00" either way. |
| D5 | **"N hours anywhere between A and B"** = total time the car is out (errands: "I'm around for the next 4 hours"). |
| D6 | **Flexibility is not a separate mode** — it is a small addition to each time ("leave at 7:00 ±30", "home by 17:00, can be earlier by 30"). |
| D7 | Steps preferred over one long page. |
| D8 | **Two stages.** Stage 1 = UX (layout, steps, anchors, flexibility presentation, quick/car-now restyle). Stage 2 = the alternative (D1–D3) and the extra time mode (D5). |
| D9 | The quick sheet and car-now follow the new look, **without** alternatives and with minimal flexibility; a different, simpler layout is fine. |

### Second round (2026-10-07) — what is being built

Supersedes the recommendation in §3 and the open questions in §7. Spec: REQ §13.110, UX_FLOWS §3.4a.

| # | Decision |
|---|---|
| E1 | **Layout A, the sentence**, for new/edit, quick and car-now. Superseded 2026-10-07 (owner): two stages — stage 1 is the sentence (who is its first chip), stage 2 holds ride type, the car field, the two notes and repeat weekly (UX_FLOWS §3.4a). Originally: where, when, who (+ the two notes) on the main screen; ride type, the car field and repeat weekly on a second "עוד אפשרויות" screen. Ride type may move into the sentence later if it is not crowded. |
| E2 | Anchors stored (two enums + the two entered times). Defaults "לצאת ב־" / "להיות בבית עד". |
| E3 | Flexibility **may** go both ways: one ± row by default, earlier/later separately when needed — for every anchor (no "deadlines only flex earlier" rule). |
| E4 | Car field = one choice: לא משנה / תא מטען גדול (the luggage requirement) / a specific car (wish). The requirement must be bypassable, possibly with a popup — **who bypasses is an open question** (see TODO). |
| E5 | `profiles.classic_request_form`: the old form everywhere (new, edit, quick, car-now) for whoever wants it. Both forms edit the same data. |
| E6 | Later stage: plan B (fairness weight **0.1**), drop points as a toggle in the destinations admin page (owner fills prod by hand), the window mode (round trips only). |
| E7 | Recent-destination chips: yes. |

## 1. What the form holds today (nothing is dropped)

Every field and behaviour of today's `RequestForm` (UX_FLOWS §3.4, §18) and where it lands in the new layout. "Step" refers to the recommended layout B (§3); A and C hold the same fields in a different arrangement.

| Today | Lands in | Notes |
|---|---|---|
| On-behalf requester (Sadran/admin) | Header of step 1 | unchanged |
| Week (resolved, `resolveWeekStart`), waitlist mode banner, late/solving banner, edit banners, join-ride banner, template banner | Header banner above the steps | one banner slot, same copy |
| Origin "מ<place> אל" (default origin / home / car location) | Step 1 | unchanged control, tappable line |
| Destination (`DestinationCombobox`, list + free text) | Step 1 | **new:** "recent" chips (member's last 4 destinations) above the search |
| Out-stops / return-stops ("+ עצירה", "+ עצירה בחזור") | Step 1 (out) / step 2 under the return time (return) | collapsed as today |
| Trip type (הלוך-חזור / הלוך בלבד / הקפצה + "צריך/ה גם איסוף") | Step 1 | three cards with a one-line meaning each; `does_not_drive` rule unchanged |
| Day (chips of target week), "חזרה ביום אחר?" (multi-day) | Step 2 | unchanged rules (`isSeriesSubmission`) |
| Depart / return time (`TimeField15`) | Step 2 | **new:** per-end anchor (§2.1) |
| Four flexibility rows (6 values each) | Step 2, attached to each time | **new presentation:** one ± row per time, "separately earlier/later" link keeps the four-value power (§2.2) |
| Companions, named children, guest names | Step 3 "מי נוסע?" | default "רק אני" — skipping the step is a valid answer |
| Large luggage ("ציוד רב — צריך תא מטען גדול") | Step 3 | |
| Ride type (required, default אחר) | Step 3 "עוד פרטים" | see Q9 |
| Preferred car | Step 3 "עוד פרטים" (collapsed) | |
| Public ride description, notes to Sadran | Step 3 "עוד פרטים" (collapsed) | separate fields as today |
| Repeat weekly | Step 3 "עוד פרטים" | weekly variant, single-day only, as today |
| Seat-fit warning, duplicate/overlap, child-overlap, published-day release confirmation, joinable rides after waitlisting, outcome toasts | Summary / after submit | unchanged dialogs and toasts |
| Template prefill, slot prefill, `?ride=` join prefill | Prefill all steps; open on the summary | |
| Edit mode | Opens on the summary | each summary line jumps to its step |

## 2. Time model

### 2.1 Anchors (stage 1)

Each end is entered as a time plus an anchor word, a small two-option toggle above the time:

| End | Anchor options | Stored as (unchanged columns) |
|---|---|---|
| Outbound | **לצאת ב־** (leave home at) / **להגיע עד** (arrive there by) | `depart_at` = time, or arrive-by − outbound route minutes |
| Return | **לצאת משם ב־** (leave there at) / **להיות בבית עד** (home by) | `return_at` = leave-there + return route minutes, or the time itself (today's meaning of `return_at` is already "arrives home", REQ §5.1) |

- Route minutes come from the same travel model as everything else (`travelBetween` / `legRouteMinutes`, stops included, unknown = 60). Rounded to the 15-minute grid away from the deadline (arrive-by rounds the departure down, leave-there rounds the return up).
- The form shows the derived time live under the field, e.g. "יציאה משוערת 8:45 (45 דק׳ נסיעה)", so the member sees what the Sadran will see.
- **Defaults:** outbound "לצאת ב־", return "להיות בבית עד" — exactly today's meaning, so a member who ignores the toggle gets today's behaviour (Q3).
- Which ends show per trip type: הלוך-חזור both; הלוך בלבד outbound only; הקפצה outbound, plus the return (pickup) when "צריך/ה גם איסוף" is on — for a pickup the natural anchor is "לצאת משם ב־" (pickup time), so it defaults there.
- **Storage (small schema change, recommended in stage 1, Q2):** enum `time_anchor` (`leave`, `arrive`); columns `requests.depart_anchor`, `requests.return_anchor` (+ the same on `request_templates`), default `leave`/`arrive`. Times stay the source of truth for the solver and SQL; the anchor only decides how the request is shown ("להגיע עד 9:30" on the card, board tooltip and the Sadran's request view) and how the form reopens on edit. Without it, an edit reopens "arrive by 9:30" as "leave at 8:45" — a visible regression, so it is in stage 1.

### 2.2 Flexibility attached to a time (stage 1)

Under each time, one compact chip row: **בדיוק · ¼ ש׳ · ½ ש׳ · שעה · שעתיים · כל היום** (today's six values). The label and meaning follow the anchor:

| Anchor | Chip row label | Maps to |
|---|---|---|
| לצאת ב־ / לצאת משם ב־ | "± אפשר לזוז" | early = late = value |
| להגיע עד | "אפשר להגיע מוקדם יותר" | depart early = value, depart late = 0 (a deadline is a deadline) |
| להיות בבית עד | "אפשר לחזור מוקדם יותר" | return early = value, return late = 0 |

- A small link "מוקדם ומאוחר בנפרד" opens the existing two-row (earlier / later) control for that end — the full four-value power stays, it just stops being the first thing a member sees.
- Collapsed by default to one line ("גמישות: בדיוק ▾") in layout B; the hint "גמישות מעלה את הסיכוי לקבל רכב" stays.
- No schema change: the four `flex_*` columns stay.

### 2.3 "N hours within a window" (stage 2, D5) — **built 2026-10-08** (REQ §13.112 c; DATA_MODEL "Request time window"; SOLVER §3.7a; UX_FLOWS §3.4a)

A third way to say "when", chosen at the top of the time step: **שעות מסוימות** | **כמה שעות בחלון**. The second shows one sentence: "צריך/ה רכב ל[4 שעות] בין [7:00] ל[12:00]" (duration = total car time).

- **Storage, recommended:** keep the existing columns as the nominal block — `depart_at` = window start, `return_at` = window start + duration, `flex_depart_late` = `flex_return_late` = window end − return_at, early flex 0 — plus one flag `requests.duration_locked boolean` meaning "shift as one block, never stretch or shrink". Every SQL reader that already understands flexibility keeps working; only the places that shift a request must respect the lock (solver `flexibility.ts`/`slots.ts`, SQL `try_auto_approve`, `_merge_check`, shift proposals). To verify in stage 2: whether a within-flex shift already moves both ends together.
- Not offered for multi-day requests, one-way or הקפצה (errands are a round trip).

**As built.** Storage exactly as recommended (`requests.duration_locked`, plus the same column on `request_templates`; the late-flex CHECKs allow any quarter hour up to a day on a locked row). The "to verify" answers: SQL placement never reads flexibility at all (a request is placed at its own `depart_at`/`return_at`), so a window request is placed as its earliest block there; the **solver** is where it slides — `bestPlacementWithinFlex` could never shift a `keep` leg's block (each end was clamped on its own), the lock adds a one-shift-for-both-ends search; `closeGapSameCar` already shifted both ends together; merges refuse to grow a locked host (SQL `merge_window_locked`) and shift it as one block. Shift proposals apply the Sadran's explicit times: an equal shift keeps the window's end (trigger `requests_duration_lock_guard`), a different length drops the lock. The classic form shows no window UI and keeps the stored lock while the length is unchanged.

## 3. Layouts (mockups)

Three layouts over the same fields and the same time model. All three keep: a sticky primary button, the details group at the end, a plain-language summary before submit, and Heebo/the app's own colours.

### A — "Sentence" (one page)

The request is one editable Hebrew sentence: "אני צריך/ה **הלוך-חזור** מ**גבעת חביבה** ל**חיפה** ב**יום ג׳ 14.10**, **להגיע עד 9:30**, **בבית עד 12:00**". Every bold part is a chip; tapping it opens a bottom sheet with that field's picker (place list, trip type cards, day strip, time wheel + anchor + flexibility). Under the sentence: "מי נוסע: רק אני ▾" and a collapsed "עוד פרטים". Stage 2 adds a second sentence under a "תוכנית ב׳" heading: "ואם אין רכב — הקפצה ל**צומת חריש** עד **9:00**, איסוף **13:00**".

- Pro: fastest for a repeat member; the sentence is also the summary; the most compact.
- Con: bottom sheet per field; first-time members may not see that words are tappable (mitigated with chip styling and a one-time hint).

### B — "Steps" (recommended)

Three short steps + summary, with a step indicator (לאן · מתי · פרטים · סיכום), back/next, and "המשך" disabled until the step is valid.

1. **לאן?** origin line, recent-destination chips, search, "+ עצירה", trip-type cards.
2. **מתי?** day strip (+ "חזרה ביום אחר?"); one card per end — anchor toggle, time, flexibility line; a live mini-timeline under the cards drawing the car's time out (driving, time there, flexibility as a faded band). Stage 2: the "שעות מסוימות / כמה שעות בחלון" switch at the top, and a **"+ תוכנית ב׳: הקפצה"** card at the bottom that expands to drop point + "להיות שם עד" + pickup.
3. **פרטים** — "מי נוסע?" (רק אני / + חבר/ה / + ילד/ה / + אורח/ת, ציוד רב) then **עוד פרטים** collapsed rows (סוג נסיעה, רכב מועדף, תיאור לכולם, הערה לסדרן/ית, בקשה חוזרת), each showing its current value.
4. **סיכום** — the sentence from A, each line tappable back to its step; warnings (seats, overlap) here; "הגש/י בקשה".

- A simple request is: destination chip → המשך → day → המשך → המשך → הגש/י (defaults everywhere else).
- Edit opens on the summary (OR1). Validation per step (`useScrollToFirstError` within the step).

### C — "Timeline"

Destination and trip type in a compact header; the main area is a horizontal day ruler (06:00–22:00, RTL) for the chosen day with the trip drawn as a block: outbound driving, time there, return driving. Tap "התחלה"/"סוף" handles or use −/+ 15 buttons to move the ends; the anchor toggles sit on the handles; flexibility is drawn as a faded extension and set by dragging it out or from chips. Other members' requests are not shown (privacy, and the open week has no rides yet). Stage 2: the window mode is a bracket on the ruler with the block sliding inside it; the alternative is a second, dashed row "תוכנית ב׳".

- Pro: makes the time model visible (arrive-by vs leave-at, flexibility, the window mode); great for D5.
- Con: precise dragging on a phone is fiddly (−/+ buttons as the primary input); the heaviest to build and test.

**Recommendation: B**, borrowing A's sentence as the summary and C's mini-timeline as a read-only preview in step 2.

## 4. The alternative — "תוכנית ב׳" (stage 2) — **built 2026-10-08** (REQ §13.112 a/b is the contract and wins over this sketch: weight 0.1 as the fairness rule param `alternativeServedWeight` instead of `alternativeWeight` 0.5; a single drop place, the pickup is from the same place; no flexibility; templates do not carry it; proposal type `alternative`; publishing waits)

**Member side.** Offered only when the main request is הלוך-חזור or הלוך בלבד (a הקפצה needs no fallback הקפצה). Fields: drop point (drop-point list + recent + free text), "להיות שם עד" time, "צריך/ה גם איסוף" (default on) with pickup place (default = the drop point) and "איסוף משם ב־" time. People are the main request's people. The summary shows it as its own line; "my rides" shows "ב׳: הקפצה לצומת חריש" on an unserved request.

**Places.** `destinations.is_drop_point boolean` (admin toggle "נקודת הקפצה" in `/admin/destinations`), seeded examples for the owner to confirm (Q6).

**Data.** `request_alternatives` (one row per request, unique `request_id`; `department_id`, `week_start`; `place_id`/`place_text`, `arrive_by`, `pickup_place_id`/`pickup_place_text`, `pickup_at`; RLS like `request_stops`; written only by `submit_request`'s `alternative` payload, read via `v_my_requests` / `v_board_rides` / solver input). Captured by templates.

**Solver.** `Request.alternative?` in `SolverInput`. After the main placement passes, an unmet request with an alternative is tried as a הקפצה (same drop-off split and chauffeur rules as any הקפצה, REQ §13.93) **without changing the main request**: success yields a suggestion `useAlternative` (new kind) → proposal type **`alternative`** (new `proposal_type` value, Sadran-sent, SOLVER §3.15). Auto-fill drafts it like other suggestions; the member's accept applies it (the request becomes a הקפצה served as the alternative, `requests.served_by_alternative = true`), decline leaves the request unmet. SQL `try_auto_approve` never applies an alternative on its own (D2).

**Fairness (D2).** A request served by its alternative counts as served × `policy.settings.alternativeWeight` (default 0.5, admin-editable in the policy editor) in the fairness rule's history and in the board/publication policy score.

**Board.** The unmet card shows the alternative under the request ("ב׳: הקפצה לצומת חריש 9:00 · איסוף 13:00") with one action "להציע תוכנית ב׳" (opens the usual draft/send choice). The siddur shows the resulting הקפצה like any other.

**Notifications.** `proposal_received` gets an `alternative` variant ("אין רכב לחיפה — אפשר הקפצה לצומת חריש עד 9:00, איסוף ב־13:00. מתאים?"), WhatsApp copy per reader (COPY_DRAFT rules). No new event.

## 5. Quick sheet and car-now (D9)

Same visual language, one screen each, no steps, no alternative, no anchors:

- **Quick (empty slot):** header "לוקח/ת את <car> ביום <day> <start>", destination with recent chips, trip type pills, two times (leave / back home), one ± chip row for the whole request ("גמישות: בדיוק ▾"), "מי נוסע: רק אני ▾", "עוד" (ride type, notes). Stops stay behind "+ עצירה".
- **Car-now:** destination + recent chips, duration chips (שעה · 2 · 3 · 4 · 6 · עד הערב), "מי נוסע: רק אני ▾", ride type. Submit "קח/י את הרכב".

## 6. Stages and work breakdown

**Stage 1 — UX** (one REQ §13 item + UX_FLOWS §3.4/§18 rewrite first, owner review)

1. `features/requests/timeAnchors.ts` (pure): anchor ↔ `depart_at`/`return_at`, flexibility mapping per anchor, rounding; unit tests. Route minutes from a small hook over `place_travel_for_week` + `legRouteMinutes`.
2. Migration: `time_anchor` enum, `requests`/`request_templates` anchor columns, `submit_request` (+ template save) accepts them, `v_my_requests` / `v_board_rides` expose them; `src/lib/enums.ts`; types + schema dump. Display: request row, board request card tooltip, Sadran request view ("להגיע עד 9:30").
3. `RequestForm` split into a shell + step components (closes the REFACTOR_BACKLOG "RequestForm 1,224 lines" item); existing `requestForm/*` field components reused; `summaryLines.ts` (pure) builds the summary sentence; recent destinations from the member's own requests.
4. Quick sheet + car-now restyle (§5).
5. Tests: `e2e/helpers.ts` `submitRequestForm()` drives the steps (most specs go through it), request-form specs, TEST_MAP area update; i18n keys in `he.member.ts`.

**Stage 2 — alternative + window mode**

6. Drop points: `destinations.is_drop_point`, admin toggle, seed.
7. Alternative: table, `submit_request`, views, solver kind + proposal type + apply, fairness weight, board action, notification variant, form card, docs (REQ, DATA_MODEL, SOLVER §3.15, UX_FLOWS §6).
8. Window mode: `duration_locked`, solver/SQL shift rules, form switch, display "4 שעות בין 7:00 ל־12:00".

## 7. Questions for the owner

1. **Layout:** A, B or C (or B with pieces of A/C, as recommended)?
2. **Anchor storage in stage 1** (§2.1) — OK to add the two small columns so cards show "להגיע עד 9:30" and edit reopens as entered?
3. **Default anchors:** "לצאת ב־" / "להיות בבית עד" (today's meaning) — or default the outbound to "להגיע עד"?
4. **Deadline flexibility:** "להגיע עד" and "בבית עד" only ever flex *earlier* (§2.2). Right?
5. **Fairness weight** of a request served by its alternative: 0.5?
6. **Drop points:** which places? (e.g. צומת חריש, תחנת רכבת בנימינה, …)
7. **Window mode for one-way/הקפצה:** round trip only, as proposed?
8. **Recent destinations** chips (the member's own last 4) — OK?
9. **Ride type** affects priority (rideType rule). Keep it in "עוד פרטים" with default אחר, or ask it in step 1 so members don't skip it?
