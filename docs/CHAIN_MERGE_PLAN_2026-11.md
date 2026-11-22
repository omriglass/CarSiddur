# CM1 — merging rides into one chained trip (plan, 2026-11-21)

Owner request 2026-11-18 (docs/TODO.md "Merging rides into one chained trip", CM1 + (a)/(b)/(c)). Status: **plan approved 2026-11-21** (answers at the end); phase 1 built 2026-11-21, phase 2 built 2026-11-21 (`20261121200000_chain_merge.sql`, suite `chain_merge.sql`), phase 3 built 2026-11-22 (`20261122090000_chain_merge_via.sql`, suite `chain_merge_via.sql`); REQUIREMENTS item 260.

## The problem today

Ride A 07:45 home → school (drop the kids) and ride B 08:30 home → Binyamina and back, both mine. Merging one into the other
today:

- **I count twice.** Seats are summed per request (`ride_seats_verdict` / `assert_ride_seats_fit`: `sum(q.adults)`), so the
  same person on two requests takes two seats (only the ride's driver is counted once).
- **The route cannot chain.** `_ride_route_with` takes the base request's own route and inserts each guest's boarding /
  alighting place **once**, at its cheapest point, and the guest must board strictly before the base's final place. So
  "B dropped on A" gives home → school → home → Binyamina (or is refused), never home → school → Binyamina → home, and a route
  that visits a place twice (needed by (a)'s "picked up") cannot be expressed at all.

## The idea

**A chain is two trips one after the other, joined where they meet.** Instead of inserting the guest's places, the merged
route is the **concatenation** of the two trips in time order, with the leg in between dropped:

| order | trip 1 | trip 2 | chained ride |
|---|---|---|---|
| drop first | A: home → school → home | B: home → Binyamina → home | home → school → Binyamina → home (A's "school → home" and B's "home →" dropped) |
| far trip first | B: home → Binyamina → home | A: home → school → home (pick up the kids) | home → Binyamina → school → home |

Which ride was dropped on which does not matter: the order is by time.

Because a concatenation can visit a place twice, the chained route is **stored on the ride** (new table, below) rather than
rebuilt from the requests every time. That one piece of storage is also what (a) "picked up" and (c) "עריכת מסלול" need.

## Rules

1. **One person counts once (on every ride, not only chains).** A person is the same profile (requester, companion, the
   driver) or the same child. The seats rule becomes "per person per stretch": `assert_ride_seats_fit`, `ride_seats_verdict`,
   `_ride_leg_fits_*`, `merge_preview`'s seat probe, the solver's `seatFit.ts` (for the merges it proposes) and the board's
   seat display. Unnamed adults and guests are never matched, so each still counts. This is worth having on its own: today's
   merges of two requests with the same person stop over-counting too.
2. **When a merge chains.** Dropping a request (or a ride) on a ride makes a chain instead of an insertion when **both**:
   - a person is on both trips;
   - one trip ends no later than the other starts, allowing for turnaround plus the drive between them, so the trips are in
     sequence rather than overlapping.

   Otherwise the merge is an insertion, exactly as today.
3. **Where the trips join.** Trip 1's return leg and trip 2's way out from home are dropped, and the car drives from trip 1's
   far end straight to trip 2's first place. Trip 1's far end becomes a stop on the chained ride's way out, with its stay (the
   time between arriving there and leaving, as asked). The added driving is compared with the detour limits, as for every merge, but over them a chain is only warned about (owner 2026-11-22), never refused
   today: the chained ride's driving, against the two trips' driving minus the dropped legs.
4. **People on only one trip.** This is question (a). Someone on trip 2 only, who would have boarded at home, either:
   - rides **the whole ride**: boards at the start of trip 1 and rides through school; or
   - is **picked up**: the chained route passes home again after school to collect them.

   The mirror case: someone on trip 1 only, who would have come back home, is **dropped home first** or **rides on**. Each
   such person is asked about once, in the merge popup. With no one like that, nothing is asked.
5. **Hours.** The chained ride starts at trip 1's start and ends at trip 2's end. Every request keeps its own fixed hours
   (LT1 REQ item 246): B still arrives by its arrive-by and leaves Binyamina at its time. Arriving early for an arrive-by is
   allowed, as everywhere. A fixed hour the chain cannot keep is the existing "לו״ז צפוף" warning, never a refusal. The time
   check `merge_time_far` (more than 2 h or the request's flexibility away) still refuses unless the Sadran overrides it.
6. **One ride, separate requests.** Both requests point to the one ride (`ride_requests`), and each keeps its own hours, its
   own place in "my rides", its own cancel, and its fairness history.
   - Cancelling or leaving one, or the Sadran unmerging it, takes out only the places nobody else on the ride uses. When one
     request is left, the stored route is dropped and that request's own route applies again.
   - The board shows one block "· מאוחד" as today, and /my shows two requests on one ride.
7. **Driver.** The chained ride's driver is trip 1's driver when that person is on the whole chain, otherwise the base ride's
   driver. The Sadran can change it (`set_ride_driver`).
8. **Who.**
   - **The Sadran:** drags a request or ride onto the other on the board. This goes through the same draft / "דיברת עם X?"
     flow as every merge (REQ §13.138).
   - **A member:** merges two of their own rides from the siddur's edit mode (`member_merge_ride`). Everyone else on the two
     rides is asked as in today's member merge.
   - **The same server check for both:** `_merge_check` decides insertion vs chain, and `merge_preview` returns the chained
     route so the popup shows it.
9. **(b) Suggest it.** When the Sadran drops or moves a ride (board), or a member does (siddur edit mode), so that it lands
   next to a ride with the same person, the app offers "לאחד את הנסיעות?". "Next to" means on any car, with a gap of at most
   turnaround plus the drive between them. Detection uses the week data already loaded, with no new reads on the hot path.

## Data

- **New table `ride_route_stops`** holds the stored route of a ride whose route is not derived from its requests. Columns:
  - `ride_id`, `department_id`
  - `leg` (`out` / `return`), `position`
  - the place (`place_id` / `place_text`)
  - `stay_minutes` (nullable)
  - `kind` (origin / stop / destination)

  Per person, where they get on and off is stored as a position on that route (`ride_route_riders`: `ride_id`, `request_id`,
  `rider_key` — requester / companion / child / guest — and the board and alight positions per leg). Seats per stretch then
  come straight from it. RLS follows `ride_requests`, and the table is written only by SECURITY DEFINER RPCs.
- `ride_route()` / `_ride_route_with()` return the stored route when the ride has one, so everything downstream follows
  unchanged: `v_board_rides.route`, `board_rows()` (the PF1 oracle), the stops view, `ride_stretches`, the summary sentence,
  ETAs and the stop schedule.
- **Writers:**
  - the merge apply (proposal accepted, offline agreement, member merge);
  - `_unmerge_core` / leave / cancel, which drop unused places, and the stored route itself when one request is left;
  - later, (c) "עריכת מסלול".
- TS twin: `src/lib/rideRoute.ts` gains the concatenation (`chainRoute`) for the instant drag highlight only. The server
  decides, as per REQ §13.108.

## Phases (each one committed and tested on its own)

1. **One person counts once:** seats in SQL (both seat functions, stretch loads), the solver's `seatFit`, and the board's
   seat count. SQL suite + Vitest. No UI change except fewer false "no seats".
2. **The chain:**
   - the storage, `_merge_check` / `merge_preview` choosing chain vs insertion, the apply, unmerge, leave and cancel;
   - the merge popup showing the chained route;
   - the board block, the siddur, /my, notices and WhatsApp (they read `ride_route`, so they mostly follow).

   Both orders. Tests: an SQL suite `chain_merge.sql`, Vitest, and an e2e for both orders (board drag + member merge).
3. **(a)** The whole-ride / picked-up question for people on one trip only, in the Sadran's merge popup and the member merge
   (a route visiting home twice).
4. **(b)** "לאחד את הנסיעות?" on drop / move.
5. **(c)** "עריכת מסלול" (ride-owned route editing) — its own item later, on the same storage.

Docs per phase: REQUIREMENTS item 260; DATA_MODEL (`ride_route_stops`, the seat rule); SOLVER (the seat rule); UX_FLOWS
(the merge popup, (a), (b)); TEST_MAP.

## Phase 2 design (worked out 2026-11-21, replaces "Data" above for phase 2)

A lighter storage than a route table, enough for phases 2–3. Phase 5 ("עריכת מסלול") may still add the table.

- **`ride_requests.chain text null`** sits on the row of the **short trip**: `before` / `before_via` / `after` / `after_via`.
  The other request stays the **route base**: the trip whose far end has the long stay (Binyamina). The 15 functions that
  choose the base (`order by (rr.role = 'driver') desc, rr.created_at, …`) stay untouched. Instead, the apply makes the long
  trip's row sort first: it takes `role = 'driver'` (`car_mode keep`) when its requester drives the chained ride, and the
  short row becomes the passenger; otherwise the short row's `created_at` is set after the base's.
- **Route (`_ride_route_with`)**, P = the chained request's points, B = the base's points:
  - `before`: out = P.out ++ B.out[1..]. P's return leg and B's way out of home are dropped.
    `before_via`: out = P.out ++ P.return[1..] ++ B.out[1..] (home again: "לאסוף מהבית").
  - `after`: return = B.return[..-1] ++ P.out[1..] ++ P.return[1..].
    `after_via`: return = B.return ++ P.out[1..] ++ P.return[1..] ("להוריד בבית בדרך").
  - The chained row is not inserted at its cheapest point.
- **Window:**
  - `before`: the chained ride starts at the short trip's own start (its ride's `starts_at`, else its `depart_at`).
  - `after`: it ends at the short trip's own end.
  - The base's far-end stay is unchanged. ETAs follow the existing forward/backward rule.
- **Coverage:** the chained row covers both legs (so its request counts as served, not `incompleteAssignments`). The seat
  counting skips its dropped leg: `before` rides only the out leg, `after` only the return leg. Its people who go on are the
  shared persons, already counted on the base.
- **Detour:** compared with the two trips driven separately (chained driving minus base minus short trip). A chain normally
  saves driving, so the limit seldom applies.
- **`_merge_check`:**
  - **Chain mode** = a shared person (requester, companion, child or driver) and the trips in sequence (one ends at or
    before the other starts, plus turnaround and the drive).
  - **Base** = the longer far-end stay. On a tie, the ride dropped onto.
  - **Side** = by time.
  - The result carries `chain: {side, base_request_id, route: [names…]}` plus, for (a), `one_trip_people` with both route
    variants.
- **Apply** (merge proposal / offline agreement / `member_merge_ride`): writes the chain value (+ `_via` from the popup's
  answer). Unmerge / leave / cancel clear it. When the base leaves, the chained row becomes the base again with its own
  route.

## Not in scope

The solver proposing chains by itself (it keeps proposing insertions only). A chain of three or more trips: possible on the
same storage, but not offered until asked for.

## Owner answers 2026-11-21

1. **Trigger:** same person on both + in sequence (as proposed).
2. **(a):** ask, "לכל הנסיעה" first, and **each option shows the route it produces** — e.g. "לכל הנסיעה — מצר ← בנימינה" /
   "לאסוף מהבית — מצר ← בית ← בנימינה" — so the Sadran / member sees the result before choosing.
3. **Driver:** the owner did not see when the two drivers differ (it happens when the shared person rides as a passenger in
   one of them, e.g. Dana drives me to school, I drive myself to Binyamina). Default kept: trip 1's driver when on the whole
   chain, else the base ride's; the Sadran can change it.
4. **Order:** go, phases 1 → 4; (c) later. Wordings built first, to approve after.
