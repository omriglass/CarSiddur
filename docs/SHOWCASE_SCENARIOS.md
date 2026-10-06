# Showcase department — scenarios and test checklist

A small, fixed department where **every member, car and request demonstrates one principle**, for hands-on testing by the owner and as a reference for future test data. Built by `npm run qa:showcase` from `scripts/qa/showcase-data.json` (same building blocks as the QA week, `docs/QA_SIMULATION.md`). Part 2 is a reusable checklist: any test data set should cover every line.

## How to load it
- Disposable stack: `npm run qa:showcase -- --out <dir> --api http://127.0.0.1:57321 [--tag <name>]`.
- The owner's own local stack (only when the owner asks): `QA_OWNER_STACK=1 npm run qa:showcase -- --out <dir> --api http://127.0.0.1:54321` — creates department **מחלקת הדגמה** (`qa-showcase`) for **next week**, open, requests filed, nothing solved. Another `--tag` gives "מחלקת הדגמה <tag>".
- Logins (password `qa-member-1234`): `sadran@<tag>.qa.local` (the Sadran), `m01`–`m08@<tag>.qa.local`. `<dir>/world.json` lets `qa:sadran` / `qa:member` drive it from the command line; `<dir>/scenarios.json` maps each scenario to its request ids.

## Part 1 — the cast

| Key | Who | Principle |
|---|---|---|
| m01 דנה כהן | regular driver at the kibbutz | baseline requests |
| m02 יואב לוי | lives in **Haifa** (default origin חיפה), drives | a member far from any car |
| m03 רותי מזרחי | **does not drive** | needs הקפצות and a volunteer driver |
| m04 מיכל אברהם, m05 אבי אברהם | **parent pair**; child נועה (4) shared, איתי (9) only m04's | child seats; the same child on two requests |
| m06 גיל פרץ | owns a **private car** (הסובארו של גיל) | only the owner puts requests on it |
| m07 שירן ביטון | very flexible | volunteer driver, merges, ask-to-join |
| m08 עומר דהן | traveller | multi-day request, equipment |

| Car | Principle |
|---|---|
| ואן 7 מקומות — 7a or 5a+2cs, `large_trunk` | the only car for a group of 6 and for equipment ("ציוד רב") |
| סקודה עם 2 מושבי ילד — 5a / 3a+2cs / 3a+1cs+1b | child seats are kept for children |
| קיה קטנה — 4a | small car; **maintenance** Tue 08:00–12:00 |
| הונדה שחונה בחדרה — 5a, base חדרה | a car that **stays at another place** (starts the week in Hadera) |
| קורולה — 5a | an ordinary car |
| הסובארו של גיל — m06's private car | private car: never used for anyone else by the solver |

## Part 1 — scenarios (next week; verified outcomes of one auto-fill on a fresh stack)

| ID | Day | Request | Principle | Expected after auto-fill | Then try (by hand) |
|---|---|---|---|---|---|
| S1 | Sun | m01 round trip → תל אביב 08:00–12:00 (late +30) | baseline placement | on a car | drag S2 onto it → merge popup (old → new times, both legs), draft or send |
| S2 | Sun | m07 round trip → תל אביב 08:30–11:30, flex ±1h | **merge candidate** (same place, overlapping) | on its own car (cars are free) | merge into S1; split merge (out with S1, back on another ride) |
| S3 | Sun | m04, **6 adults** → זכרון יעקב 10:00–14:00 | seats | on the **van** only | try dropping it on a 5-seat car → refused "seats" |
| S4 | Sun | m08 **equipment** (luggage) → נתניה 15:00–18:00 | big trunk | on the **van** (after S3) | drop on another car → refused "ציוד רב דורש רכב עם תא מטען גדול" |
| S5 | Mon | m03 (no license) **הקפצה with pickup** → בנימינה 08:30, pickup 13:00 | long wait: two chauffeur legs | two driverless chauffeur rides, the car comes back between | assign a volunteer driver (m07) on each; check the passenger's notices |
| S6 | Mon | m03 **short הקפצה** → כרכור 15:00, pickup 15:45 | wait ≤ 2 × turnaround → one ride | **one** driverless chauffeur ride 15:00–15:45 | "חבר הלוך ואיסוף" when they were split |
| S7 | Mon | m06 **הקפצה without pickup** → מענית 11:00 | one-leg chauffeur ride | one driverless chauffeur ride | volunteer driver |
| S8 | Mon | m01 **one way** → עפולה 09:00 | the car stays where the ride leaves it | relay ride home→Afula | — |
| S9 | Mon | m07 **one way from** עפולה → home 16:00 | complementary one-ways | paired with S8 on the same car (the car waits in Afula) — *see discrepancy D1* | — |
| S10 | Tue | m02 (Haifa) round trip **from Haifa** → עפולה 09:00–13:00 | no car where the member is | **unmet**: "אין רכב פנוי שנמצא בחיפה"; suggestions: start from the kibbutz (van), public transport, deny | send the origin proposal / "no car in your town" proposal |
| S11 | Tue | m07 round trip **from חדרה** → חיפה 14:00–17:00 | a car standing at the origin | on the **Hadera Honda** | mark a **car move** Hadera→kibbutz before it and see it refused/moved |
| S12 | Tue | m04 → חיפה 10:00–15:00 **via זכרון יעקב** | multi-stop | ride shows "via(out) זכרון יעקב" | — |
| S13 | Tue | m01 → **free text** "קניון חוצות המפרץ" 16:00–19:00 | free-text place | placed (the small car, after its maintenance) | — |
| — | Tue | small car maintenance 08:00–12:00 | maintenance block | the small car is unavailable then | drop a request on it in that window → refused |
| S14 | Wed | m04 **kids run** with נועה + איתי → פרדס חנה 07:30–08:30 | child seats | on the **child-seat Skoda** | — |
| S15 | Wed | m05 kids run with **נועה** → פרדס חנה 07:45–08:30 | **the same child on two requests** | on a child-seat-capable car (van) + the board's duplicate-child warning | "משיכה ככפילות" on one; the member answers "not a duplicate" |
| S16 | Wed | m01 alone → כרכור 07:30–09:00 | child seats go to children | **not** on the Skoda (Corolla) | — |
| S17 | Wed | m06 round trip → נתניה 10:00–13:00 **on his private car** | private car | on הסובארו של גיל, pinned | try dropping someone else on it → refused (private car) |
| S18 | Wed | m07 → נתניה 10:00–13:00, **ask to join** S17's ride | ask-to-join a private car | a merge draft on the private car's ride (filed in an open week) — *see D2* | in a published week: the owner answers it |
| S19 | Wed–Fri | m08 **multi-day** → ירושלים Wed 08:00 → Fri 14:00 | one car held for days | one car (the small one) for 3 days, "series 1/3…3/3" | Sadran "להציע פחות ימים"; m08 "קיצור הבקשה" (down to one day) |
| S20–S23 | Thu | m01, m04, m06, m07 round trips 08:00–12:00 to nearby places | **more requests than cars** (S19 holds one car, the Honda is in Hadera) | 3 placed, **1 unmet** with "start from Hadera" suggestion | proposals (origin / external / deny); publish; waiting list |

### Live-phase scenarios (after publishing — by hand, no data needed)
- **Late request** (any member, a published day) → auto-approved when a car is free, else waiting list; the Sadran gets one notice.
- **Edit on a published day** (m01 moves S1 by 30 min) → same car when it fits, notice "old → new".
- **Cancel** as the driver (m01), as a passenger (S2 after merging into S1), as the requester of a chauffeur ride (m03 S5), one leg of a הקפצה → the driver is told; freed-car offer for the car's whole free gap.
- **Freed car** → offered to waiting members (Thursday's unmet request).
- **Car-now** (רוצה רכב עכשיו) works only in the *current* week: load with `--this-week` to test it.

### Known discrepancies (found while building this, 2026-10-06)
- **D1** — Auto-fill pairs complementary one-way legs (S8 + S9) **automatically**; REQ item 105 a says they are *suggested*, never paired automatically.
- **D2** — An ask-to-join filed in an open (unpublished) week becomes a Sadran merge *draft* on the private car's ride; in a published week it should go to the owner directly (REQ consistency decision 19) — check it there.

## Part 2 — coverage checklist for any test data set

Make sure the data has **at least one** of each:

**Cars**
- [ ] a big car (7 seats) — the only one for a large group
- [ ] a car with a large trunk (equipment requests need it)
- [ ] a car with child-seat configurations, and cars without
- [ ] a small car (4 seats)
- [ ] a car based away from home (starts the week elsewhere)
- [ ] a car with a maintenance block on a working day
- [ ] a private (member-owned) car with rides of its owner

**Members**
- [ ] a member living far from home (default origin elsewhere, no car there)
- [ ] a member who does not drive
- [ ] a parent pair sharing a named child (+ a child of only one of them)
- [ ] a private-car owner
- [ ] a flexible member who can volunteer to drive
- [ ] a member with a multi-day request

**Requests**
- [ ] plain round trip from home; one with flexibility, one rigid
- [ ] two overlapping requests to the same place (merge candidate)
- [ ] a group larger than most cars; an equipment request
- [ ] הקפצה with pickup — long wait (two legs) and short wait (one ride)
- [ ] הקפצה without pickup
- [ ] one way to X, and one way from X back (complementary)
- [ ] a request from a place where no car is; one from a place where a car stands
- [ ] a request with a stop on the way; a free-text destination
- [ ] a kids run with child seats; the same child on two parents' requests; an adult alone at the same time
- [ ] the private car's owner's own ride; someone asking to join it
- [ ] a multi-day request (3 days)
- [ ] a day with more requests than free cars

**Actions to exercise (Sadran)**
- [ ] auto-fill once (everything it can place, in one click)
- [ ] merge by drag (both legs, out only, return only); split merge (two rides); merge into a ride still needing a driver
- [ ] draft vs send; edit a draft; publish with drafts/expiring proposals warned
- [ ] shift proposal (time and car); origin proposal; external ("no car in your town" / every car taken); deny
- [ ] assign / replace a volunteer driver
- [ ] trip-type change on an unmet card (with confirmation)
- [ ] mark a car move ("העברת רכב") and see it decide where the car is
- [ ] fewer days for a multi-day request; withdraw a duplicate
- [ ] publish; then the live phase above

**Actions to exercise (members)**
- [ ] answer proposals (accept / decline; the other party's notice; "אישרת — ממתין לאחרים")
- [ ] edit before and after publishing (warning when the car would be lost)
- [ ] overlap warning ("cancel the other one / keep both"); child-on-another-request warning
- [ ] cancel as driver / passenger / chauffeur requester / one leg
- [ ] ask to join; "+ נוסעים"; shorten a multi-day request; "not a duplicate"; one-tap "on my private car"
- [ ] my rides, siddur, inbox: every notice names the route, the day (with weekday) and old → new
