# carshare-nevo — Solver design

Status: **DRAFT v0.3** (2026-09-06, owner answers applied; one-way/relay model and car location added). Derives from `docs/REQUIREMENTS.md` v0.3 (§5, §5.4, §6, §7, §8, §13); if the two disagree, REQUIREMENTS wins.

The solver is a pure TypeScript package at `src/solver`. No DOM, no Supabase, no `Date.now()`, no `Math.random()`. It runs in the browser (Sadran board) and, unchanged, in a Supabase edge function. It is deterministic for identical inputs, explainable (every decision carries a Hebrew reason), and unit-tested with Vitest.

---

## 0. Lessons from the reference app (commucar-share)

`SettingsTab.tsx` (`processBookingsForWeek`, `detectCollisionsForDay`, `findAvailableCarWithSwap`, `validateNoOverlaps`) and `WeeklyScheduleTable.tsx` (`pendingPlacements`) taught us:

| Reference behaviour | Verdict |
|---|---|
| Pinned bookings seeded into occupancy so everything routes around them | **Keep** (our `fixedRides`). |
| Prefer a car the member used before ("continuity") | **Keep**, as a tie-breaker only. |
| Final `validateNoOverlaps` pass before persisting | **Keep**, as an invariant assertion + property test. |
| Deterministic fallback car order (sorted by name) | **Keep**, sort by `car.id`. |
| 30-minute slots, whole-slot occupancy | Replace with 15-minute grid. |
| Any slot where `pending + approved > cars` marks *all* pending as "collision" — no ranking, no partial service | **Avoid.** We rank by policy and serve as many as possible. |
| No seat, luggage, buffer or flexibility logic; no merge detection | **Add** all of them. |
| One-level "displacement swap" with no budget, driven by continuity rather than by need | Replace with a budgeted improvement pass that only moves rides inside their declared flexibility. |
| Supabase writes interleaved with the algorithm (a failure mid-loop leaves a half-written week) | **Avoid.** The solver returns a value; persistence is the caller's job (REQUIREMENTS §11: solver failures never corrupt the draft). |
| `pendingPlacements` computed in a `useMemo` and auto-saved from an effect | **Avoid** side effects from derived state. |

---

## 1. Problem statement and formal model

### 1.1 Entities

- **Grid.** The target week is Sunday 00:00 to Saturday 24:00 Asia/Jerusalem, divided into 15-minute **slots**. A slot is an integer index from the week start. DST days have 92 or 100 slots; the solver never does wall-clock arithmetic — the caller supplies epoch timestamps and per-day slot bounds (§3.1).
- **Location** `ℓ`: a destination row; the department's **home** `H` is one of them (zone `home`). The solver reasons about locations only by id equality (REQUIREMENTS §5.4, §13.57–58).
- **Request** `r`: requester `m(r)`, destination `dest(r)` (with `zone`, `distance_km`, `travel_minutes`, `public_transport_score`, or zone `unknown` for free text), ride type, trip shape, legs, passengers `p(r) = (adults, childSeats, boosters)`, `luggage ∈ {0,1}`, `needsCarAtDestination`, `canDrive` (default `true`), `drivingCompanionIds` (named companions who can drive, REQUIREMENTS §13.88 owner 2026-09-16), `oneWayCarMode` (deprecated input, now ignored entirely — kept in the type only so legacy/DB rows still deserialize), flexibility intervals, submission time, late flag, optional manual boost.
  - **Legs.** `tripShape ∈ {round_trip, one_way_to, one_way_from}`. A round trip has an **out** leg (leave `H` at departure `D`, travel `H → dest`) and a **return** leg (arrive `H` at return `R`, travel `dest → H`). `one_way_to` has only the out leg, `one_way_from` only the return leg.
  - **Car mode of a leg** `mode(leg) ∈ {keep, relay, passenger, chauffeur}` (REQUIREMENTS §5.4). Round trips with `needsCarAtDestination = true` are one fused `keep` block, driven by the requester unless `canDrive === false` (§1.3.10a). **Pairing decides the mode of a one-way leg, not the member** (REQUIREMENTS §13.88, rule made precise 2026-09-16, superseding the 2026-09-15 wording): the member never states a mode, and any stored `oneWayCarMode` is ignored for everyone. A leg is a **relay candidate** whenever it has an eligible driver on board (the requester, if `canDrive !== false`, else a `drivingCompanionIds` entry) — `relay.ts`'s pairing then either confirms it as a real `relay` leg (a matching leg to the same destination, also with an eligible driver on board) or, when unpaired, places it as a standalone `chauffeur` ride (§3.6.1a) — never left waiting at the destination. A leg with no eligible driver on board is `passenger` unconditionally, falling back to `chauffeur` when no host exists (§3.11 item 5). `chauffeur` from the suggestion ladder is only ever a suggestion; the §3.6.1a standalone chauffeur placement is an actual solver placement (nobody's plan needs to change — it is simply the outcome). For a `drop_off` round trip (`needsCarAtDestination = false`) each leg is resolved independently the same way, and **never** falls back to `keep` (§1.3a, REQUIREMENTS §13.94).
  - **Flexibility.** Independent intervals `FD(r) = [D − a, D + b]` and `FR(r) = [R − c, R + d]` (each side one of 0/15/30/60/120 min or "any time that day", which the caller resolves to the day's slot bounds).
- **Car** `c`: `type ∈ {shared, temporary}`, seat configurations `Q(c) = {(A, C, B)…}`, features (e.g. `large_trunk`), maintenance blocks (slot intervals), `luggageCapacity` (REQ §13 item 21, yes/no since 2026-10-07: 0 without `large_trunk`, > 0 with it — a flag, not a count; a large-luggage request is placed, merged, relayed, shifted or swapped only onto a big-trunk car, and any number of them may share that car), and a **location timeline**: the car starts the week at `H`; every ride moves it from its `originId` to its `destinationId`; between rides it sits where the last ride left it.
- **Fixed rides**: pinned rides, applied/accepted proposals, temporary-car owner rides. Immutable inputs with a car, a window, origin/destination and passengers; the requests they serve are excluded from solving.
- **Policy**: `{ id, version, rules: {type, weight, params}[] }`.
- **Ride** (output): one car, one window `[s, e)`, an `originId` and `destinationId` (where the *car* is when the ride starts and ends — both `H` for a round trip or a chauffeur ride), one driver (a driver request, or a volunteer for chauffeur rides), served legs with their car modes, passenger totals.

### 1.2 Occupancy of a leg

`travel = dest.travelMinutes ?? config.defaultTravelMinutes` (60); `dwell = config.chauffeurDwellMinutes` (10).

| Leg / mode | Car occupancy window | Car origin → destination |
|---|---|---|
| Round trip, `keep` (`needsCarAtDestination = true`, or fallback) | `[D, R)` — one fused block | `H → H` |
| `out`, `relay` | `[D, D + travel)` | `H → dest` — the car stays at `dest` |
| `return`, `relay` | `[R − travel, R)`; requires the car to be at `dest` at `R − travel` | `dest → H` |
| `out`, `chauffeur` (drop-off) | `[D, D + chauffeurMinutes)` — `2·travel + dwell` with no stops | `H → H` |
| `return`, `chauffeur` (pick-up) | `[R − chauffeurMinutes, R)` | `H → H` |
| any leg, `passenger` | none of its own — a seat in a host ride whose leg goes the same way (§3.8) | host's |
| Round trip, `needsCarAtDestination = false` (`drop_off`) | Each leg as `passenger`/`relay`/`chauffeur` (§1.3a: never `keep`); two `relay` legs on the same car leave it parked at `dest` in between, *free for others there*. | per leg |

**`chauffeurMinutes` — one rule for solver and SQL (REQUIREMENTS §13.117 c, R8B13):** `ceil((route + direct + dwell) / 15) · 15` minutes, rounded **once** from exact minutes (`chauffeurTotalSlots()` in `travel.ts`; SQL `chauffeur_ride_minutes()`, which `place_request_on_car` uses for every hand placement). `route` = the leg's own route minutes (stops included), `direct` = the empty drive origin ↔ destination (= `route` with no stops), `dwell` = `chauffeurDwellMinutes`. Rounding each part separately (3 + 3 + 1 slots for 31 + 31 + 10 minutes = 105 min) was the QA run 8 mismatch with the hand placement (75 min). The pickup candidate (car at the destination) ends at `D + routeSlots` with the same total duration.

Every window is rounded outward to the grid and has `minDurationSlots = max(1, ceil(occupancy / 15))`. A one-way request without a round trip is `durationFixed` (one shift dimension).

### 1.3 Hard constraints

1. **No overlap.** For rides `x ≠ y` on the same car: `s_y ≥ e_x + buffer` or `s_x ≥ e_y + buffer`. The same rule applies between a ride and a maintenance block. `buffer = config.bufferMinutes` (30, REQUIREMENTS §13.10). **Exception (owner 2026-09-24, REQUIREMENTS §13.88):** the two legs of one relay pair need only `s_return ≥ e_out` — the car just waits at the destination — while each leg keeps the full buffer against every other ride and block (`CarTimeline` `relayPairId`, the same zero-buffer rule as legs of one multi-day series).
2. **Seat fit** (§3.3): `Σ p(r)` over the ride's requests (plus one adult for a chauffeur volunteer) is dominated by some configuration of the car. Each request's `adults` includes its own would-be driver; when a request rides along as a passenger, *all* of its adults/childSeats/boosters join the host's load (its former driver is now a passenger) and the host's driver is counted exactly once, inside the host request's own `adults`. Nothing is ever subtracted.
3. **Luggage** (yes/no): a ride with any luggage request needs `luggageCapacity(c) > 0` (a large-trunk car); there is no per-car count cap (`luggageFits(car, n) = n ≤ 0 ∨ luggageCapacity > 0`).
4. **Temporary cars** are never assigned by the solver; they are never merge hosts either: `findMergeHosts` skips hosts on temporary cars, so auto-fill, merge suggestions and `splitLegs` never put another member's request on a private car (REQUIREMENTS §13.99; ask-to-join to the owner stays a manual request). They never relay or chauffeur — `origin = destination = car.baseLocationId ?? H` always (REQUIREMENTS §13.93, §1.3a: a temporary car's base need not be `H`).
5. **Fixed rides** are never moved.
6. Placements stay inside the request's declared flexibility, except `shiftBeyondFlex` *suggestions* (≤ 2 h, consent required).
7. Merges require detour `≤ config.detour` (20 min / 15 km) and are never applied by the solver — they are suggestions (REQUIREMENTS §13.4).
8. **Location.** A ride may start on a car only if the car's location at `s` equals the ride's `originId` (§3.2). Consequently the rides of a car chain: `destinationId(x_n) = originId(x_{n+1})`.
9. **Day end — retired 2026-10-04 (REQUIREMENTS §13.93, §1.3a).** The rule below ("every shared car is at `H` at day end") and its `CAR_AWAY_AT_DAY_END` invariant no longer apply; a car legitimately stays wherever its last ride left it, across days and weeks. Kept verbatim for history (its chauffeur-placement content, in particular, still describes current behavior — just read "H" there as the request's own origin, §1.3a): Every shared car is at `H` at the department's day end (`DayBounds.dayEndSlot`, default 23:59). **Superseded 2026-09-16 (REQUIREMENTS §13.88/§13.89, rule made precise — replaces the 2026-09-15 "needs-driver relocation ride" wording):** the solver never places a lone (unpaired) relay leg as `relay` — that would leave the car waiting at the destination. An unpaired relay candidate is instead placed as a standalone **chauffeur** ride wrapped around the leg (`H → dest → H` for an out leg, `H → dest → H` "to fetch" for a return leg — §3.6.1a), so the car is home at day end simply because it never left. This is only tried when a shared car actually has room for the whole chauffeur window; when none does, the leg still falls back to the old `UNMET_NO_RELAY_PARTNER` suggestion ladder (§3.11 item 5). Fixed rides may still leave a car away at day end only when the caller marks them `overnightAck` (Sadran acknowledged, or a manual/series gap only covered by an unclaimed DB `auto_relocation` row, REQUIREMENTS §13.89); the solver then treats the car as starting the next day where it was left.
10. **Chauffeur** rides need a driver who is not the requester; the solver never invents one. A `chauffeur` from the suggestion ladder (§3.11 item 5) is a Sadran-actioned suggestion; the §3.6.1a standalone chauffeur placement is a real solver placement (an unpaired relay candidate's *outcome*, not something the Sadran opts into) — both wait for a volunteer/pinned driver the same way.
10a. **Non-driver members** (`Request.canDrive === false`, REQUIREMENTS §13.88, owner 2026-09-15/16) are never given a driver role themselves: no `keep` round trip driven by them, no `relay` leg driven by them. A round trip that would otherwise be `keep` is placed exactly like any other round trip but **driverless** (`PLACED_NEEDS_DRIVER`, `driverRequestId`/`driverMemberId` both absent, the requester's own leg is `role: 'passenger'`) — the Sadran finds a volunteer or the member brings a guest driver; when it cannot be placed at all, the ordinary unmet `merge` suggestion (§3.8) covers "a seat in someone else's ride". A one-way leg has an eligible driver on board — and is therefore still a relay candidate (§1.1, §3.6.1) — when a named `drivingCompanionIds` entry can drive even though the requester cannot; the solver then names that companion `driverMemberId` and the requester's own leg reads `role: 'passenger'` (owner 2026-09-16: "a driving companion becomes the driver automatically"). With no eligible driver on board at all, the leg is `passenger` unconditionally and never pairs; since owner 2026-09-24 (REQUIREMENTS §13.88) it is then placed as a standalone missing-driver chauffeur ride exactly like an unpaired relay candidate (`chauffeurUnpairedRelayLegs(…, 'noDriver')`, reason `PLACED_NEEDS_DRIVER`), matching the SQL healing; only when no car has room does it stay `UNMET_PASSENGER_NO_HOST` with the §3.11 item 5 suggestions.

### 1.3a Origins, trip types, cars stay where they are left (REQUIREMENTS §13.93, amended 2026-10-04)

Supersedes §1.3 items 8/9 as written above (kept for history; this section is authoritative). Design brief: `docs/ORIGINS_PLAN_2026-10.md` §4 (solver step O4).

- **Origin.** `Request.originId?: string` (undefined = `SolverInput.homeLocationId`); resolve it only via `originIdOf(request, homeLocationId)` (`src/solver/travel.ts`), never by reading the field directly. `Request.originIsFreeText?: boolean` — such a request is never normalized and never placed (its own `UnmetRequest`, reason `UNMET_FREE_TEXT_ORIGIN`, no suggestions beyond `deny`). Every leg a request supplies runs *origin → destination* (a `return` leg: *destination → origin*) — "home" in §1–§3 below means "the request's own origin" wherever a *request's* leg is concerned; `homeLocationId` itself is still used for genuinely department-level things (the department's own base, "car now"-style helpers, `Car`/`CarTimeline`'s default base/start location).
- **Trip type.** `Request.tripType?: 'round_trip' | 'one_way' | 'drop_off'` (= SQL `trip_type`); `effectiveTripType(request)` derives it when absent, exactly mirroring the SQL backfill: any one-way shape (`one_way_to`/`one_way_from`), or a round trip with `needsCarAtDestination = false`, is `drop_off`; everything else is `round_trip`. **No legacy combination of fields ever derives the new `one_way` value** — only an explicit `tripType: 'one_way'` does — so every pre-existing golden fixture, test and the one-way pairing parity suite keep deriving `drop_off` unchanged, with their origin defaulting to home.
  - `round_trip`: unchanged — one `both`/`keep` leg, origin → origin.
  - `drop_off`: today's one-way relay/chauffeur/passenger handling (§3.6.1/§3.6.1a, §3.9), generalized to the request's own origin instead of hardcoded home. A relay pair now also requires both legs to share the same `originId` (meaningless extra check for every legacy, home-origin case).
  - **A `drop_off` with a pickup is two separate trips (REQUIREMENTS §13.94, owner 2026-10-05, G4).** There is no `keep` fallback for it, even for a requester who can drive: `solve()` rewrites every `drop_off` request that has both a departure and a return (and is not a multi-day series, free-text origin, or already served by a fixed ride) into two ordinary one-way `drop_off` requests `<id>#out` / `<id>#ret` (`src/solver/dropOffSplit.ts`: out gets `flexDeparture` and the out-stops, return gets `flexReturn` and the return-stops), solves them with the unchanged pairing / chauffeur (`chauffeurCandidates`) / passenger machinery, and maps every id back to the original request id in the output (`servedRequestIds`, leg/driver/suggestion/warning request ids). The request can therefore appear in two assignments (one per leg) and, when only one leg is placed, in both an assignment and an `UnmetRequest` for the other leg (when both legs are unmet the two records are merged into one: out-leg reason, union of blockers and suggestions, one `deny`). The car is free between the trips. **Connecting the halves (REQUIREMENTS §13.95 H2):** when the requester (or a driving companion) can drive, `pairRelays` ranks the pair of a request's own `#out`/`#ret` (`Request.splitFrom`, set by `dropOffSplit.ts`, internal, never output) before any cross pairing with another member's leg, **only when the wait is uncontested (REQUIREMENTS §13.103a: fewer other requests overlap the wait window than there are shared cars; otherwise the own pair is dropped and the legs are separate chauffeur legs, the car returning in between)**, so both legs land on **one car driven by the requester** (out leg ends at the destination, return leg starts there, no buffer between, the car bookable only from there); if no car can take the connected pair, each half falls back to the chauffeur path (`chauffeurUnpairedRelayLegs`) instead of staying unmet. Non-drivers keep chauffeur/passenger. SQL healing connects legs only when both already sit on one car, so the solver's choice can differ from SQL for a fresh solve — an accepted, documented divergence (the shared pairing JSON has no split-request case). `splitLegs.ts`/`SUGGEST_SPLIT_LEGS` is no longer reachable from a bridge-built input (only an explicit `tripType: 'round_trip'` with `needsCarAtDestination = false` still produces a `keep` leg).
  - `one_way` (new): a single `out`/`relay` leg, origin → destination, with **no pairing obligation and no chauffeur fallback** — it never enters `pairRelays`/`chauffeurUnpairedRelayLegs`. (One exception, REQUIREMENTS §13.117 d: two *unmet* one-way legs going opposite ways between the same places are placed together on one car by `pairComplementaryOneWays()`, §3.6.1d.) It is placed exactly like a `round_trip` single unit (same greedy/flex-search machinery), governed only by `CarTimeline.isFree`'s end-check (below). Unplaceable → its own `UnmetRequest`, reason `UNMET_NO_CAR_AT_ORIGIN`; it still goes through the ordinary suggestion ladder (§3.11), which — because an unmet `one_way` leg has the same shape as an unmet `drop_off` relay-out leg — naturally offers `convertToRoundTrip`/`chauffeur` ("as a drop-off it would fit") without any special-casing.
- **`CarTimeline.isFree(w, originId, relayPairId?, endLocationId?)`:** free AND the car is at `originId` when `w` starts, as before; **new** — when `endLocationId` is given and differs from `originId` (i.e. this candidate would leave the car somewhere other than where it started), the car's *next* block after `w`, if any, must itself start at `endLocationId`. This is the "no later ride on this car silently stranded" check a `one_way`/relay leg needs and a `keep`/chauffeur leg never triggers (`endLocationId === originId` there). Every single-unit and relay-pair placement site now passes this 4th argument (a no-op for `keep` legs).
- **Location-neutral blocks (REQUIREMENTS §13.96):** a Sadran reservation (`FixedRide.locationNeutral`, set by the bridge for a ride serving no request that is not an automatic relocation ride) is stored as a `locationNeutral` block. It occupies time exactly like any block (overlap, turnaround buffer, `isFree` time checks) but never moves the car: `locationAt()` passes through it, `chainBreaks()` skips it (the next real ride is compared with the last real ride's end), `isFree`'s end-check looks for the next *real* block, `add()` does not check its start location, and `weekEndAway()`/`awayWindows()`/`dayEndViolations()` ignore it. It has no legs, so it is never a merge host. **The day-end rule is retired.** `CarTimeline.dayEndViolations()` / the `CAR_AWAY_AT_DAY_END` invariant / `WARN_CAR_AWAY_AT_DAY_END` are no longer used by `solve()` (the method itself stays, `@deprecated`, for the board's pre-O5 code). A car legitimately stays wherever its last ride left it, across days *and weeks*. `CarTimeline.add()` still throws for a solver-placed block whose claimed start location doesn't match (a solver bug, never a legitimate state); `forceAdd()` (fixed rides only) never throws — neither on a location mismatch nor on a buffer/overlap clash (fixed rides are facts). A clash is recorded (`fixedConflicts(): string[]`, surfaced as warning `FIXED_RIDE_CONFLICT` / `WARN_FIXED_RIDE_CONFLICT`); pieces of one multi-day series (`FixedRide.seriesId` -> `Block.seriesId`) are exempt from the buffer between each other (QA run 1 QB1). A location mismatch is recorded as a **chain break** instead: `chainBreaks(): { rideId, carLocationId, rideOriginId }[]`, surfaced by `solve()` as warning `WARN_CHAIN_BROKEN` (replaces the old per-seed `WARN_FIXED_RIDE_LOCATION_MISMATCH` check). `weekEndAway(): { locationId } | null` compares the car's location at week end against `car.baseLocationId ?? homeLocationId`; `solve()` turns a non-null result into warning `WARN_CAR_AWAY_AT_WEEK_END`.
- **Car base.** `Car.baseLocationId?: string` (undefined = `homeLocationId`) — "where it belongs" for `weekEndAway()` and the temporary-car-never-leaves-home invariant (now "never leaves its base"). It does **not** affect placement (that's still governed entirely by the timeline's actual, tracked location).
- **Travel.** `SolverInput.travel?: TravelEdge[]` (`{ fromId, toId, distanceKm?, travelMinutes? }`, symmetric) plus the pure helper `travelBetween(input, fromId, toId): { minutes, km? }` (`src/solver/travel.ts`): same place → `0`/`0`; an explicit `travel` row (either direction) wins; home ↔ X falls back to `destinations[X]`'s own `travelMinutes`/`distanceKm` (today's only lookup, preserved exactly for every home-origin leg); anything else falls back to `config.defaultTravelMinutes` with `km` left `undefined`. Replaces every direct `destinations[id].travelMinutes` lookup used for *leg* travel time (`normalize.ts`'s `travelSlotsFor`, the `distance` rule) and the request-leg chauffeur-wrap window; it does **not** change `merge.ts`'s destination-to-destination detour heuristic (still the pre-existing distanceKm/travelMinutes difference — a documented simplification, since merges are now origin-filtered anyway, see below).
- **Merges** (§3.8) are now restricted to the **same origin**: `findMergeHosts` derives each host's own request-origin from its driver `AssignmentLeg` (`'return'` leg → its `destinationId`; `'out'`/`'both'` → its `originId`) and skips any host whose origin differs from the guest's `originId` — a no-op filter for every legacy (home-origin) request.
- **`changeOrigin` suggestion** (new `SuggestionKind`, `src/solver/suggestions.ts`): for an unmet request, a car that is free for its *entire preferred window* at another place Y it already occupies (so placing the request's origin at Y breaks nothing already committed) → `{ kind: 'changeOrigin', carId, originId: Y, window }`. Shown to the Sadran only, never auto-applied; SOLVER §3.15 maps it to proposal type `origin`. Simplification (§9-style): only the exact preferred window is tried, first car/location pair in deterministic order — no flexibility search.
- **Chauffeur wrap, generalized (amended 2026-10-04, owner follow-up).** `chauffeurUnpairedRelayLegs`/the `chauffeur` suggestion (`src/solver/travel.ts`'s `chauffeurCandidates()`) implement ORIGINS_PLAN §3's full rule: for an `out` leg `A → B` at departure `D`, a chauffeur ride is created when the car is at `A` (drop-off: `[D, D + routeSlots + directSlots + dwell)`, car wraps `A → B → A`) **or** at `B` (pickup: `[D − directSlots − dwell, D + routeSlots)`, car wraps `B → A → B`, fetching the requester at `A` just in time for `D` — e.g. "pick me up from Harish": origin Harish (`A`), destination Givat Haviva (`B`), the car is based at Givat Haviva). `routeSlots` is the requester's own leg duration (§1.3b below — stop-aware); `directSlots` is the chauffeur's empty repositioning drive `A ↔ B` direct, never revisiting the stops (`routeSlots === directSlots` with no stops, byte-identical to the old `2·travel + dwell` formula). Both candidates are tried, drop-off first, in deterministic car order; neither free → unmet. A `return` leg keeps the legacy single formula, anchored at the request's own origin. A no-op generalization for every home-origin, no-stop request (its only reachable candidate is still the drop-off one).

### 1.3b Multi-stop rides (REQUIREMENTS §13.93 "Multi-stop rides", ORIGINS_PLAN §6, amended 2026-10-04)

- **Stops.** `Request.stops?: { leg: 'out' | 'return'; locationId?: string }[]` — extra waypoints on a leg, in route order (array order filtered by `leg`; there is no separate position field). `locationId` undefined is a **free-text stop**: it still gets a travel hop (`config.defaultTravelMinutes` on both adjoining hops, never a real `travelBetween` lookup) but it never matches merge joining (below) — there is no managed place to board at. `SolverConfig.stopMinutes?: number` (default 5, `resolveStopMinutes()`) is the dwell added per stop, mirroring `department_settings.stop_minutes`.
- **Route and route minutes (`src/solver/travel.ts`).** `legRoute(lookup, request, leg)` returns the leg's ordered waypoints: `out` = `[origin, ...out-stops, destination]`; `return` = `[destination, ...return-stops, origin]`. `legRouteMinutes(lookup, request, leg, stopMinutes)` = Σ `travelBetween`/`defaultTravelMinutes` over consecutive hops + `stopMinutes × stopCount`; `legRouteSlots(...)` rounds that outward to the grid (`Math.max(1, Math.ceil(minutes / 15))`) — the drop-in replacement for the old single-hop lookup wherever a leg's **own** duration (not an empty repositioning drive) is needed. With no stops, `legRouteMinutes` reduces to exactly `travelBetween(origin, destination).minutes` — every existing golden fixture and the one-way pairing parity suite are therefore unaffected.
- **Where route minutes replace the plain lookup:** the `one_way` and legacy `drop_off` relay windows (`slots.ts` — a request's own `travelSlots` is now its leg's route slots, computed once per the relevant direction; a `round_trip`/`keep` request is **unchanged**, since its fused block's window `[D, R]` never depended on travel time to begin with), the chauffeur wrap's `routeSlots` term (above), and `findMergeHosts`'s route-based joining (below). It does **not** change `merge.ts`'s destination-to-destination detour heuristic for the no-stop case (still the pre-existing distanceKm/travelMinutes difference).
- **ETAs.** `stopEtas(lookup, request, leg, anchorSlot, stopMinutes)` returns `{ locationId, slot }[]` for the stops only, in leg/position order — `out` counts forward from `anchorSlot` (the departure slot); `return` counts backward from `anchorSlot` (the arrival-at-origin slot), mirroring SQL `request_stop_etas`. `routeEtaAt(lookup, request, leg, anchorSlot, stopMinutes, locationId)` generalizes this to **any** route node, including the origin/destination endpoints (`stopEtas` only ever returns the stops in between) — `undefined` when `locationId` isn't on the route (a free-text stop never matches here either).
- **Joining at a stop (§3.8; superseded 2026-10-05 by cheapest insertion, REQUIREMENTS §13.95).** A stop is just an existing node of the host's leg route: a guest boarding/alighting there needs no insertion (zero added driving), anything else is inserted at least cost within the detour limit. A fixed-ride host's route is the plain two-node `[originId, requestDestinationId]` (the solver never sees its `.stops`), a documented simplification.

### 1.4 Objective

Maximize `Σ_{served r} score(r)` (policy-weighted served requests; a relay pair serves two requests) subject to the hard constraints. Secondary, lexicographically: minimize total shift minutes from preferred times; minimize detour minutes; minimize car-away idle minutes (time a car sits at a destination between relay legs); minimize the number of cars that change relative to `previousAssignments`. The solver is a heuristic (ordered greedy + bounded local improvement), not an exact optimizer; the objective defines the tie-breakers and the tests, not a proof of optimality.

---

## 2. Input / output types

```ts
// src/solver/types.ts
export type Slot = number;               // 15-min index from week.startMs
export type Window = { start: Slot; end: Slot };   // half-open [start, end)
export type Passengers = { adults: number; childSeats: number; boosters: number };

export interface DayBounds { dayIndex: 0|1|2|3|4|5|6; startSlot: Slot; endSlot: Slot; dayEndSlot: Slot }
// dayEndSlot = department_settings.day_end_time on that day (default 23:59 → endSlot − 1); cars must be home by then.

export type TripShape = 'round_trip' | 'one_way_to' | 'one_way_from';   // = SQL trip_shape
export type LegSide = 'out' | 'return' | 'both';                          // = SQL ride_leg
export type LegCarMode = 'keep' | 'relay' | 'passenger' | 'chauffeur';   // = SQL leg_car_mode
export type TripType = 'round_trip' | 'one_way' | 'drop_off';            // = SQL trip_type (REQUIREMENTS §13.93, §1.3a)

export interface TravelEdge { fromId: string; toId: string; distanceKm?: number; travelMinutes?: number }  // SolverInput.travel row (§1.3a)

export interface Destination {
  id: string; name?: string; zone: string;  // name: display name for reason texts (§3.13a); 'unknown' for unclassified free text; 'home' for the department base
  distanceKm?: number; travelMinutes?: number;
  publicTransportScore?: number;            // 0..1, 1 = excellent service
}

export interface Flexibility { earlierMin: number | 'day'; laterMin: number | 'day' }

export interface Request {
  id: string; memberId: string; departmentId: string;
  destinationId: string; rideType: string;
  tripShape: TripShape;
  originId?: string;                        // REQUIREMENTS §13.93 (§1.3a): undefined = homeLocationId; read via originIdOf(), never directly
  originIsFreeText?: boolean;                // §1.3a: never normalized, never placed (UNMET_FREE_TEXT_ORIGIN)
  tripType?: TripType;                      // §1.3a: undefined -> effectiveTripType() derives it from the legacy fields
  oneWayCarMode?: 'relay' | 'passenger';    // DEPRECATED (REQUIREMENTS §13.88, 2026-09-16): ignored entirely; kept only for legacy/DB rows
  departureMs?: number; returnMs?: number;  // epoch ms, 15-min aligned; departure absent for one_way_from, return absent for one_way_to
  flexDeparture: Flexibility; flexReturn: Flexibility;
  durationLocked?: boolean;   // REQ §13.112 (c): a window request shifts as one block (§3.7a)
  passengers: Passengers; coRiderMemberIds: string[];
  luggage: boolean; needsCarAtDestination: boolean;   // round trips only
  submittedAtMs: number; isLate: boolean;
  manualBoost?: { value: number; reason: string };   // value 0..1
  preferredCarId?: string;                  // carried over from a previous draft
  canDrive?: boolean;                       // default true; false -> never a driver role themselves (§1.3.10a, REQUIREMENTS §13.88)
  drivingCompanionIds?: string[];           // named companions who can drive (REQUIREMENTS §13.88, owner 2026-09-16); only matters when canDrive === false
  stops?: { leg: 'out' | 'return'; locationId?: string }[];  // §1.3b (REQUIREMENTS §13.93 "Multi-stop rides"); locationId undefined = free-text stop
}

export interface Car {
  id: string; name: string; type: 'shared' | 'temporary'; ownerMemberId?: string;
  seatConfigs: Passengers[]; features: string[]; luggageCapacity: number;
  maintenance: Window[];
  startLocationId?: string;                 // where the car is at week start; default = home
  baseLocationId?: string;                  // REQUIREMENTS §13.93 (§1.3a): "where it belongs"; default = home; used only by weekEndAway()
}

export interface FixedRide {
  id: string; carId: string; window: Window;
  originId: string; destinationId: string;  // car location at start / end
  driverRequestId?: string;                 // absent for chauffeur rides (driverMemberId set instead)
  driverMemberId: string;
  legs: AssignmentLeg[]; servedRequestIds: string[];
  passengers: Passengers; luggageCount: number;
  overnightAck: boolean;                    // Sadran acknowledged the car is not home at day end
  kind: 'pinned' | 'acceptedProposal' | 'temporaryOwner';
}

export interface PolicyRuleConfig { type: string; weight: number; params: unknown }
export interface Policy { id: string; version: number; rules: PolicyRuleConfig[] }

export interface SolverStats {
  fairness: Record<string, { deficit: number }>;      // memberId → 0..1, supplied by caller
  usualCarId: Record<string, string>;                 // memberId → carId
}

export interface SolverConfig {
  bufferMinutes: number;            // default 30 (the week's settings_overrides.turnaround_minutes, else department_settings.turnaround_minutes — bridge: effectiveWeekSettings(), REQ §13.108 a)
  detour: { maxMinutes: number; maxKm: number };      // default 20 / 15
  beyondFlexMaxMinutes: number;     // default 120
  defaultTravelMinutes: number;     // default 60, used when the destination has no travel_minutes
  chauffeurDwellMinutes: number;    // default 10 (department_settings.chauffeur_dwell_minutes)
  improvementBudget: number;        // max relocation evaluations, default 5000
  perRequestBudget: number;         // default 200
  externalHints: { cabMaxMinutes: number; rentalMinHours: number; ptMinScore: number };
  stopMinutes?: number;             // §1.3b, default 5 (department_settings.stop_minutes)
  chauffeurSuggestions?: boolean;   // REQUIREMENTS §13.117 a (R7B2): absent/false = the `chauffeur` suggestion kind is not produced (hidden for the pilot); placement-time chauffeur rides are unaffected
}

export interface SolverInput {
  week: { startMs: number; days: DayBounds[] };
  homeLocationId: string;                   // departments.home_destination_id
  cars: Car[]; requests: Request[]; fixedRides: FixedRide[];
  destinations: Record<string, Destination>;
  policy: Policy; stats: SolverStats; config: SolverConfig;
  travel?: TravelEdge[];                    // REQUIREMENTS §13.93 (§1.3a): read only via travelBetween()
  previousAssignments?: Pick<Assignment, 'servedRequestIds' | 'carId'>[];
}

// One served leg of one request — becomes one ride_requests row.
export interface AssignmentLeg {
  requestId: string; leg: LegSide; carMode: LegCarMode;
  originId: string; destinationId: string;  // where the *requester* travels: out = home → dest, return = dest → home, both = home → dest (and back)
  role: 'driver' | 'passenger';
}

export interface Assignment {
  rideId: string; carId: string; window: Window;
  originId: string; destinationId: string;  // where the *car* is at ride start / end (= rides.origin_id / destination_id); both home unless a relay leg
  driverRequestId?: string;                 // undefined for a chauffeur ride (nobody has claimed the driver role yet)
  driverMemberId?: string;                  // the requester, or a drivingCompanionIds entry when the requester can't drive; set by the Sadran for chauffeur rides
  legs: AssignmentLeg[]; servedRequestIds: string[];
  passengers: Passengers; luggageCount: number;
  shift: { departureMin: number; returnMin: number };   // signed, 0 if at preferred
  pairedRideId?: string;                    // the other leg of a relay pair (§3.6.1); undefined for a standalone chauffeur placement (§3.6.1a — never left waiting at the destination, so there is no partner)
  source: 'fixed' | 'solver';
  reasonCode: string; reason: string;                     // Hebrew
}

export interface UnmetRequest {
  requestId: string; score: number;
  blockers: { carId: string; rideIds: string[] }[];
  suggestions: Suggestion[];                              // ordered
  reasonCode: string; reason: string;
}

interface SuggestionBase { requestId: string; reasonCode: string; reason: string; cost: number; confidence: number }
export type Suggestion =
  | (SuggestionBase & { kind: 'shiftWithinFlex'; carId: string; window: Window;
       shift: { departureMin: number; returnMin: number }; relocations: Relocation[] })
  | (SuggestionBase & { kind: 'merge'; hostRideId: string; guestRequestIds: string[]; leg: LegSide;
       proposedDriverRequestId: string; window: Window; hostShift?: { departureMin: number; returnMin: number };
       detourMinutes: number; detourKm: number; boardAtLocationId?: string })  // §1.3b: where the guest boards (multi-stop)
  | (SuggestionBase & { kind: 'shiftBeyondFlex'; carId: string; window: Window;
       shift: { departureMin: number; returnMin: number }; pairsWithRequestId?: string })
  | (SuggestionBase & { kind: 'splitLegs'; outbound: { hostRideId?: string; carMode: 'passenger' | 'relay'; departSlot: Slot; carId?: string };
       return: { hostRideId?: string; carMode: 'passenger' | 'relay'; arriveSlot: Slot; carId?: string } })
  | (SuggestionBase & { kind: 'convertToRoundTrip'; carId: string; window: Window; returnSlot: Slot })
  | (SuggestionBase & { kind: 'chauffeur'; leg: 'out' | 'return'; carId: string; window: Window;
       volunteerCandidateMemberIds: string[] })
  | (SuggestionBase & { kind: 'externalHint'; hint: 'cab' | 'rental' | 'publicTransport' })
  | (SuggestionBase & { kind: 'deny' });

export interface Relocation { rideId: string; fromCarId: string; toCarId: string; window: Window }

export interface MergeOpportunity {
  hostRideId: string; guestRideId: string; freedCarId: string; freedWindow: Window;
  detourMinutes: number; reason: string;
}

export interface SolverOutput {
  policyId: string; policyVersion: number;
  assignments: Assignment[]; unmet: UnmetRequest[];
  mergeOpportunities: MergeOpportunity[];
  carsAway: { carId: string; locationId: string; window: Window }[];   // for the board's location badges
  warnings: { code: string; message: string; requestId?: string }[];
  stats: { served: number; unmet: number; needsDriver: number; relocations: number; budgetExhausted: boolean; elapsedMs: number };
}

export function solve(input: SolverInput): SolverOutput;
```

`cost` is a positive number, lower is better, comparable only within one `kind`; `confidence ∈ [0,1]` estimates the chance the suggestion is accepted (declared flexibility → high, beyond flex → lower, merge → depends on detour, shift and passenger count). Suggestions are ordered by the REQUIREMENTS §7.1 kind rank, then `cost`, then `requestId`. `volunteerCandidateMemberIds` of a `chauffeur` suggestion is informational: members with a placed ride on the same day and no ride overlapping the chauffeur window, sorted by id — the Sadran may pick anyone.

---

## 3. Algorithm

Module layout (one responsibility per file):

```
src/solver/
  index.ts        solve(), matchFreedSlot()
  types.ts        normalize.ts   seats.ts   timeline.ts (location-aware)
  policy/engine.ts   rules/index.ts   rules/<type>.ts
  assign.ts  relay.ts  flex.ts  merge.ts  split.ts  improve.ts  suggest.ts
  reasons.ts      Hebrew templates keyed by reasonCode
  __fixtures__/   __tests__/
```

### 3.1 Normalization (`normalize.ts`)

- `toSlot(ms) = floor((ms − week.startMs) / 900_000)`. Departure floors, return ceils; misalignment emits a warning `TIME_NOT_ALIGNED`.
- Numeric and `'day'` flexibility are clipped to the request's own `DayBounds`; preferred, improved, relay, and beyond-flex placements cannot cross midnight. Ordinary quarter-hour returns end by `endSlot − 1` (23:45). An explicitly requested 23:59 return conservatively occupies `endSlot` internally, and persistence restores the exact requested minute. Return-only requests use their actual timestamp's day, before ceiling. DST boundaries come from the caller's `DayBounds`.
- **Legs.** From `tripShape`/`needsCarAtDestination`/`canDrive`/`drivingCompanionIds` (`resolveOneWayMode()`, REQUIREMENTS §13.88, rule made precise 2026-09-16) build `NormalizedLeg { side: 'out'|'return'|'both', preferredMode: LegCarMode, originId, destinationId, window, flex: [lo, hi] }` per §1.2 (`round_trip` + needs car → one `both` leg `keep`; `round_trip` without → `both` leg `keep` as fallback plus `out`/`return` legs eligible for `passenger`/`relay`; `one_way_to` → `out` leg in the resolved mode; `one_way_from` → `return` leg in the resolved mode). `resolveOneWayMode()` ignores any stored `oneWayCarMode` entirely: the mode is `relay` (a *candidate*, confirmed or downgraded to `chauffeur` only once pairing runs, §3.6.1/§3.6.1a) whenever `hasEligibleDriver(request)` — the requester when `canDrive !== false`, else a `drivingCompanionIds` entry — else `passenger` unconditionally.
- Build `NormalizedRequest { legs, window, minDurationSlots, flexDep: [lo, hi], flexRet: [lo, hi], durationFixed: boolean, travelSlots }`. For one-way shapes `durationFixed = true` (only one shift dimension). `travelSlots` is the leg's own `legRouteSlots()` (§1.3b) — equal to `ceil((dest.travelMinutes ?? config.defaultTravelMinutes) / 15)` when the leg has no stops, larger when it does (out-stops for `one_way_to`/explicit `one_way`, return-stops for `one_way_from`). A `round_trip`'s fused `keep` leg keeps the plain origin↔destination value (§1.3b: unaffected by stops, its window never depended on travel time).
- Requests served by a `FixedRide` are marked `servedByFixed` and skipped; their fixed rides become `Assignment { source: 'fixed' }` and seed the timelines with their origin/destination.
- Validation warnings, never throws: return before departure, outside week, passenger set fits no active car (`NO_CAR_FITS_SEATS`), a fixed ride whose origin does not match the car's location at its start (`FIXED_RIDE_LOCATION_MISMATCH` — reported, the fixed ride is still honoured), a fixed ride leaving a car away at day end without `overnightAck` (`CAR_AWAY_AT_DAY_END`). **Removed 2026-09-15** (REQUIREMENTS §13.88): `ONE_WAY_MODE_MISSING` — an absent `oneWayCarMode` is now the normal case (the form no longer asks), resolved silently by `resolveOneWayMode()`, not a data problem worth a warning.

### 3.2 Car timelines (`timeline.ts`)

```ts
export interface Block { rideId: string; window: Window; startLocationId: string; endLocationId: string; locationNeutral?: boolean /* reservation, REQ §13.96 */ }
export interface Gap { window: Window; locationId: string }        // where the car sits during the gap

export class CarTimeline {
  constructor(car: Car, bufferSlots: number, weekSlots: number, homeLocationId: string);
  isFree(w: Window, originId: string, relayPairId?: string, endLocationId?: string): boolean;
  // O(log n): free AND the car is at originId when w starts; when endLocationId differs from
  // originId (REQUIREMENTS §13.93, §1.3a), the car's next block after w (if any) must itself
  // start at endLocationId — a no-op check for keep/chauffeur legs (endLocationId === originId).
  locationAt(slot: Slot): string;                    // O(log n)
  gaps(): Gap[];                                     // free intervals with the car's location, O(n)
  add(b: Block): void;                               // O(n) insert into sorted array; rejects a block whose startLocationId ≠ locationAt(start)
  forceAdd(b: Block): void;                          // fixed rides only: never rejects on a location mismatch, records it instead (chainBreaks())
  chainBreaks(): { rideId: string; carLocationId: string; rideOriginId: string }[];
  weekEndAway(): { locationId: string } | null;      // vs car.baseLocationId ?? homeLocationId (§1.3a)
  remove(rideId: string): void;
  awayAt(slot: Slot): boolean;                       // locationAt(slot) ≠ home (display/carsAway concern — unrelated to weekEndAway's base)
  awayWindows(): { locationId: string; window: Window }[];   // for SolverOutput.carsAway
  /** @deprecated REQUIREMENTS §13.93 (§1.3a): no longer used by solve(); kept for the board's pre-O5 code. */
  dayEndViolations(days: DayBounds[]): { window: Window; causeRideId?: string }[];
}
```

Every occupancy (ride, maintenance block, fixed ride) is stored as `[start, end + buffer)` with its start/end location; maintenance blocks do not move the car (`start = end = locationAt(start)`). A candidate `[s, e)` with origin `o` is legal iff `[s, e + buffer)` is disjoint from all stored intervals **and** `locationAt(s) = o` — this yields exactly the symmetric rule of §1.3.1 plus the location rule of §1.3.8 with one binary search; `isFree`'s optional `endLocationId` adds the forward end-check of §1.3a on top. The car's location between blocks is the `endLocationId` of the preceding block (or `car.startLocationId ?? home` before the first). Per car there are at most a few dozen intervals, so a sorted array beats a tree. **The day-end rule is retired (§1.3a, REQUIREMENTS §13.93):** `dayEndViolations()` stays, `@deprecated`, but `solve()` no longer calls it; the only remaining location warning is `weekEndAway()` vs `car.baseLocationId ?? homeLocationId`.

### 3.3 Seat fitting (`seats.ts`)

```ts
export function dominates(q: Passengers, p: Passengers): boolean;  // q.adults ≥ p.adults ∧ q.childSeats ≥ p.childSeats ∧ q.boosters ≥ p.boosters
export function fits(car: Car, p: Passengers): boolean;            // ∃ q ∈ car.seatConfigs: dominates(q, p)
export function slack(car: Car, p: Passengers): number | null;     // min over dominating q of Σ(q − p); null if !fits
export function sum(...ps: Passengers[]): Passengers;
```

Dominance is strictly component-wise; no substitutions are inferred (a booster child does not fit a child-seat position and vice versa). Configurations are enumerated by the admin exactly so that the solver never reasons about physical seat geometry.

**Seat accounting for merges (canonical; mirrored by the DB trigger in `DATA_MODEL.md` §5.2).** A request's `adults` includes its own would-be driver (REQUIREMENTS §5.1 "including the driver"). When guest `g` is merged as a passenger into host ride `h`, the ride's load is `sum(h.passengers, g.passengers)` — every adult, child seat and booster of `g` is added, because `g`'s former driver now sits as a passenger. The host's driver is counted once, inside `h.passengers.adults`. Example: host 1 adult, guest 2 adults + 1 child seat → load (3, 1, 0), which fits a `{3,1,0}` configuration of a 5-seater. **Chauffeur rides** (REQUIREMENTS §13.65): the volunteer belongs to no request, so the load is `sum(served requests) + (1, 0, 0)`. Seat fit is checked **per leg**: a relay pair is two rides with independent loads; a split-leg request adds its people to each host's matching leg only. `slack` drives the "tightest fit" heuristic; built-in child seats are informational only.

### 3.4 Hard-constraint predicate

```ts
export function canPlace(car: Car, tl: CarTimeline, leg: NormalizedLeg, req: NormalizedRequest, w: Window): boolean
// car.type === 'shared' && fits(car, load(leg)) && luggageOk(car, [req]) && tl.isFree(w, leg.carOriginId)
// leg.carOriginId = home for keep / chauffeur / relay-out, = dest for relay-return; load(leg) adds (1,0,0) for chauffeur
```

### 3.5 Scoring (`policy/engine.ts`, details in §4)

`scoreRequests(input, pairs) → Map<requestId, { total, breakdown }>`. Relay pairing (§3.6.1) runs **before** scoring so the `peopleServed` rule can count both legs of a pair; pairing itself never looks at scores. Units are then sorted by `(−total, submittedAtMs, id)`. This order is the only place priority enters the greedy phase.

### 3.6 Ordered greedy assignment (`assign.ts`)

The greedy pass places **units**: a single request, or a **relay pair** (two one-way `relay` requests, §3.6.1) that must land on one car together. Units are sorted by `(−score, submittedAtMs, id)` where a pair's score is the higher of its two requests' scores (pairing never demotes the stronger request) and its id is the smaller of the two.

```
units = pairRelays(relayRequests) ∪ remaining single requests     // §3.6.1
for u in sortedUnits:
  candidates = []
  for car in sharedCars sorted by id:
    if !fits(car, load(u.legs)) or !luggageOk: continue
    if every leg of u: tl[car].isFree(leg.window, leg.carOriginId): candidates.push({car, windows: preferred, shift: 0})
  if candidates empty:
    for car in sharedCars: p = bestPlacementWithinFlex(tl[car], u); if p: candidates.push(p)
  if candidates empty: unmet.push(...u.requests); continue
  choose min by carChoiceKey; for each leg: tl[car].add(block); assignments.push(...)
```

Preferred time is always tried first on every car; flexibility is used only when no car is free at the preferred time. For a pair, `isFree` of the back-leg is evaluated on the timeline *after* the out-leg block is added (the car is then at `dest`, so the back-leg's origin matches); nothing else can use the car from home while it is away, because `isFree(w, home)` fails during the away gap.

**Car choice key** (lexicographic, all deterministic):

1. `shiftCost = |departureShift| + |returnShift|` (minutes; for a pair, the sum over both legs)
2. soft preferred-car rank: zero when no preference was supplied or this is the preferred car, otherwise one; for a relay pair sum the two members' mismatch ranks. This only ranks feasible cars and never alters request priority or the time-first search.
3. `slack(car, passengers)` — tightest seat fit, keeps large cars for large groups (for a pair: the max over the two legs)
4. continuity: `0` if `car.id === previousAssignment(r).carId`, else `1` if `car.id === stats.usualCarId[member]`, else `2` (for a pair: the min over both members)
5. & 6. mileage balance and best-fit packing (`fragmentation`) — **which ranks above the other is the policy's `carChoice` option** (`'pack' | 'spread'`, absent = `'spread'`; owner decision 2026-09-14, REQUIREMENTS §13.84, §3.6.2 below):
   - `spread` (default): **mileage balance** (single round trips only, F5) — `(car.mileageKm ?? 0) + kmAssignedToThisCarSoFarInThisSolve` — `0` for every car, hence inert, unless the input actually carries `mileageKm` — ranks above **fragmentation**: leftover of the gap the ride lands in (`gap.length − ride.length`, best-fit) — avoids splitting a long free window (for a pair: the gap is `[out.start, back.end)`). Across days, best-fit alone prefers the car whose remaining window is already shorter, i.e. the car that drove yesterday, which is exactly the piling-up this ranking undoes.
   - `pack`: the same two fields, **fragmentation before mileage** — packing wins so rides pile onto already-used cars, keeping whole cars free; mileage still decides once packing itself has tied.
7. `car.id`

#### 3.6.1 Relay pairing (`relay.ts`)

```ts
export function pairRelays(requests: NormalizedRequest[], ctx): { pairs: RelayPair[]; unpaired: NormalizedRequest[] }
export interface RelayPair { outRequestId: string; returnRequestId: string; destinationId: string; idleSlots: number; shift: {...} }
```

Input: every **relay candidate** — a leg with an eligible driver on board (`hasEligibleDriver()`, REQUIREMENTS §13.88; the requester when `canDrive !== false`, else a `drivingCompanionIds` entry) — `out` legs (`one_way_to`, and the out leg of a `needsCarAtDestination = false` round trip) and `return` legs (`one_way_from`, and the return leg of such a round trip). Pairing itself never re-checks who drives — eligibility is already baked into `preferredMode === 'relay'` by normalization (§3.1) — it only checks destination/time/seats. Rule (REQUIREMENTS §5.4, §13.58): `o` and `b` pair iff

- same `destinationId` (exact; zone-level pairing is v1.x),
- `o.window.end ≤ b.window.start` after choosing the minimal shift of each inside its own declared flexibility (`b.start` may be pushed later, `o.start` earlier — never beyond flex),
- both on the same local day (the car must be home by `dayEndSlot`),
- each leg's own passengers fit some shared car — the pair is later placed on one car, so `fits` is checked per leg against the car (§3.3).

A gap shorter than the buffer still pairs (owner 2026-09-24). The placed out-leg then carries `Assignment.turnaroundAfterMinutes` = the actual gap in minutes, which `applySolve` sends as `rides.turnaround_override_minutes` so the DB trigger accepts the tight pair (`20260924120000_relay_pair_short_gap.sql`); SQL healing (`pair_one_way_legs`) applies the same rule to persisted legs but never shifts a member's own times.

Greedy matching: candidate pairs sorted by `(idleSlots + shiftCost, outId, returnId)` — no scores, because pairing runs before scoring (§3.5); each request joins at most one pair. `idleSlots = b.start − o.end` is the time the car sits at the destination. A request whose round trip was split into two relay legs pairs **with itself** (car parked at the destination in between, free for third parties there) — this is the `relay+relay` resolution of §3.9 and is tried only when the fused `keep` block does not fit. Pairs whose match needs a shift beyond declared flexibility (≤ 2 h) are not formed but remembered, and surface as `shiftBeyondFlex` suggestions with `pairsWithRequestId` on the leg that would have to move. Unpaired relay candidates are handed to §3.6.1a next, before falling back to `unmet`.

#### 3.6.1b QA run 4 rules (REQUIREMENTS §13.104; `relay.ts`, `greedy.ts`, `index.ts`)

- **R4B1 — one click finishes.** Every unmet *pair* unit (an own connected pair **or** a cross-request relay pair) hands both legs to the chauffeur path in the same solve (`index.ts`); before, only own pairs did, so a leg whose cross partner stayed unplaced was lost and a second solve (partner now fixed) placed it. Test: `idempotent.test.ts` (solve, then solve with its own rides fixed adds nothing).
- **§13.104a** `pairRelays` drops every candidate whose wait is *contested* (`waitContested()`: other requests overlapping the wait >= shared cars), not just own `#out`/`#ret` pairs.
- **§13.104b** `chauffeurShortDropOffs()`: the two halves of one drop-off + pickup with no driver on board and a wait of at most 2 x `bufferMinutes` (uncontested) become ONE chauffeur ride `[out start, return end]` (`PLACED_NEEDS_DRIVER`, both legs on the assignment).
- **§13.104c** car-choice key gains `kidSeats` right after `preference`: a request without child seats/boosters ranks a car with child-seat capacity worse while another unplaced request overlapping it needs child seats. A child's leg that no free car with fitting seats can take reports `UNMET_NO_CAR_SEATS_BUSY` instead of `UNMET_NO_RELAY_PARTNER`.
- **R4B7** an `out` chauffeur leg whose car is parked at a third place starts early by the empty drive there and ends back where the car was parked (never relocates the car, so one click still finishes; only for a car parked away from home, the pickup and the drop-off).

#### 3.6.1c QA run 5 rules (REQUIREMENTS §13.105; `relay.ts`, `index.ts`, `suggestions.ts`)

- **R5B8 — a short wait is never contested.** `pairRelays(…, shortWaitSlots)` (called with `2 x bufferMinutes` in slots, the §13.104b threshold): an own `#out`/`#ret` pair (one הקפצה by a member who can drive) whose wait `returnWindow.start − outWindow.end` is at most that is connected even when `waitContested()` is true. Two chauffeur wraps burn more car time than a 30-minute wait and left the driving requester with two overlapping driverless rides on two cars. If no car holds the whole `[out.start, ret.end]`, the legs still fall back to the chauffeur path. SQL parity: `connect_drop_off_legs` skips its "wait needed elsewhere" test for a wait <= 2 x turnaround (migration `20261011200200`).
- **R6B6 — a car move is a fixed, location-deciding ride.** `boardRideToFixedRide` (TS bridge, not the solver) keeps a driverless `auto_relocation` ride whose `pin_reason` is `CAR_MOVE` as a fixed ride (only the DB's own unclaimed relocation placeholders are dropped), so `weekEndAway()` / `chainBreaks()` see a car move back to base and `CAR_AWAY_AT_WEEK_END` no longer fires.
- **R5B2 — chauffeur rides at the car's own place.** The R4B7 ride (car parked at a third place Y: empty drive to the pickup, back to Y) has `originId === destinationId === Y`, which is neither end of the leg. `ride_requests_leg_location()` now requires only `origin = destination` for `chauffeur` (migration `20261011200000`); before, the first whole-week `apply_solver_result` raised `leg_location_mismatch (chauffeur_same_place)` and applied nothing.
- **§13.105b `pickupFromCarAtX()`** (runs before `chauffeurUnpairedRelayLegs`, over the same unpaired + own-pair-fallback legs): an unpaired `return` relay leg `X -> origin` whose car already **stands at X** (`CarTimeline.isFree(window, X, undefined, origin)`), free for the leg's own window, with a driver on board (requester or driving companion, `eligibleDriverMemberId`) is placed as one relay-mode ride X -> origin (`PLACED_PICKUP_FROM_CAR_AT_X`, `driverRequestId` = the leg's request). No volunteer, no wrap. Only the leg's own window is tried. SQL: `place_request_on_car` tries this as candidate 0 for a `return` leg when no volunteer was named (migration `20261011200100`; `try_auto_approve` never places a `drop_off`, REQ §13.94).
- **§13.105a `chainOneWay` suggestion** (`chainOneWaySuggestion()` in `suggestions.ts`, §3.11 item 3a, §3.15): see there.


#### 3.6.1d Complementary one-way pairs (`oneWayPairs.ts`, REQUIREMENTS §13.117 d/e, R8B14)
Explicit `one_way` requests never enter relay pairing (§1.3a) and are placed one by one; two of them that go **opposite ways** between the same places (`X → Y` of member A, `Y → X` of member B, same day, different members, each with an eligible driver) can block each other — A alone strands the car's next ride (it starts at `X`), B alone finds no car at `Y` — so after the greedy/improve pass `pairComplementaryOneWays()` places the still-unmet ones together on **one car**: A's block `X → Y`, B's block `Y → X`, tagged with one `relayPairId` (no turnaround buffer between them, the ordinary buffer against everything else, B's end must not strand the car's next ride). Candidate pairs are ordered by the larger score, then ids; for each pair the `(startA, startB)` combinations inside the two declared departure flexibilities are tried by smallest total shift, then car id (A's end ≤ B's start); the first car that fits both passenger loads and luggage wins. Output: two assignments, `PLACED_RELAY_PAIR`, `pairedRideId` each other, each member `driver` of their own leg. **Simplification:** the car's wait at `Y` is not tested for contention (§13.103a) — the alternative is two unplaced members, and the Sadran sees both rides. Runs before the chauffeur healing; SQL has no counterpart (explicit one-way legs are never paired there; the Sadran places the second leg by hand, which the strand check then accepts).
**True unmet reason (`oneWayUnmetCause()`):** an unmet one-way leg gets `UNMET_ONE_WAY_STRANDS_CAR` when a fitting car stands at the origin in a free window but ending at the destination would strand its next ride; `UNMET_NO_CAR_AT_ORIGIN` only when no fitting car stands at the origin during the request's span; otherwise `UNMET_NO_CAR` (blockers).

#### 3.6.1a An unpaired relay candidate becomes a chauffeur placement (`relay.ts`'s `chauffeurUnpairedRelayLegs`, REQUIREMENTS §13.88/§13.89, rule made precise 2026-09-16)

**Supersedes the 2026-09-15 "needs-driver relocation ride" design (formerly `healLoneRelayLegs`/`PLACED_RELAY_SOLO`, now removed):** the owner's restated rule (REQUIREMENTS §13.88) is that pairing decides the mode, not the member — "if nobody can drive back, my leg is a chauffeur ride". A lone (unpaired) relay candidate is **never** placed as a `relay` leg (that would leave the car waiting at the destination); instead it becomes a standalone **chauffeur** ride: a home round trip wrapped around the requester's own leg, `[D, D + 2·travel + dwell)` for an out leg (drop-off) or `[R − 2·travel − dwell, R)` for a return leg (pick-up) — the same occupancy formula as an ordinary chauffeur ride (§1.2) and the same window the `chauffeur` suggestion (§3.11 item 5) would offer. The requester rides as a passenger; the ride waits for a volunteer/pinned driver like any other needs-driver ride. The car is **never** left away — there is no relocation ride and no `pairedRideId`.

```ts
export function chauffeurUnpairedRelayLegs(
  unpaired: NormalizedRequest[], timelines: Map<string, CarTimeline>, input: SolverInput,
  carsById: Map<string, Car>, scores: Map<string, { total: number }>,
): { healed: Assignment[]; healedIds: Set<string> }
```

Runs after the greedy pass and the improvement pass (so `timelines` reflects every other placement), over `pairRelays()`'s leftover `unpaired` list, in priority order (score desc, then `submittedAtMs`, then `id` — the same comparator as everywhere else, §3.14). For each still-unpaired leg, on the first shared car (by id) that fits `chauffeurLoad(nr.passengers)` (the requester's load plus one adult for the volunteer, §3.3) and luggage, and is free at home for the whole chauffeur window: one ride lands in `SolverOutput.assignments` — `originId`/`destinationId` both home, `legs: [{ ..., carMode: 'chauffeur', role: 'passenger' }]`, `driverRequestId`/`driverMemberId` both absent, `reasonCode: 'PLACED_CHAUFFEUR_NO_RETURNER'` — counted in `stats.needsDriver`. A car with no room for the whole window is skipped; a leg no car can take this way keeps the old `UNMET_NO_RELAY_PARTNER` path (§3.11 item 5) unchanged — whose own `chauffeur` suggestion tries the identical window again.

Simplification (documented, in the style of §9.1): only the leg's own preferred window is tried — no flexibility search for the healing placement itself.

**Amended 2026-10-04 (REQUIREMENTS §13.93, §1.3a, owner follow-up):** every "home" above generalizes to the leg's own `A`/`B` (origin/destination) via `chauffeurCandidates()` (`src/solver/travel.ts`) — for an `out` leg `A → B` at departure `D`, two candidates are tried, in order: the car at `A` (drop-off, `[D, D + 2t + dwell)`, today's formula) and the car at `B` (**pickup**, `[D − t − dwell, D + t)` — the car fetches the requester at `A` just in time for `D` and returns to `B`; e.g. "pick me up from Harish": origin Harish/`A`, destination Givat Haviva/`B` where the car is based). Both are a no-op for a legacy home-origin request (`A = home`, so only the drop-off candidate is ever reachable there, byte-identical to before). A `return` leg keeps the legacy single formula, anchored at the request's own origin, unchanged. This only ever applies to `drop_off` legs (legacy one-way derivation, or an explicit `drop_off`); an explicit `one_way` trip type never reaches this function (§1.3a: no chauffeur fallback). `findChauffeurCar` (the `chauffeur` *suggestion*, §3.11 item 5) tries the identical candidates.

#### 3.6.2 Mileage balancing across shared cars, and the `carChoice` policy option (F5, REQUIREMENTS §13.84)

Optional, opt-in, and third/fourth-to-last in the car-choice key (§3.6 items 5 & 6, just before `car.id`): `Car.mileageKm?: number` is kilometres this car drove in a rolling window before this week (v1: 4 weeks, fixed — no department setting), fed in by `buildSolverInput` from the SQL `car_mileage_totals()` RPC. It only ever breaks a genuine tie among cars that are otherwise **equally acceptable** — identical `shiftCost`, preferred-car rank, seat slack and continuity — never overriding preferred car, seat fit, availability or continuity (those are checked first, unchanged).

Whether mileage or the best-fit packing heuristic (`fragmentation`) is checked first is `Policy.carChoice: 'pack' | 'spread'` (absent = `'spread'`, owner decision 2026-09-14 — a policy-version-scoped, admin-editable option, `policy_versions.settings.carChoice`, `create_policy_version`'s `p_settings` param, DATA_MODEL §3.4; edited on the priority-policy editor, UX_FLOWS §5.8):
- `spread` (default, today's behaviour): mileage ranks above `fragmentation` — `fragmentation` then only separates cars with equal mileage.
- `pack`: `fragmentation` ranks above mileage — rides pack onto already-used cars, keeping whole cars free ("more available resources"); mileage still decides once `fragmentation` itself has tied. Because `fragmentation` now sits ahead of mileage in `pack` mode, `greedy.ts`'s `coreKeyEqual` (which `MileageDecisionTracker` uses to tag `CAR_BALANCED_MILEAGE`, below) additionally requires `fragmentation` to tie before crediting mileage with the decision — otherwise a placement `fragmentation` actually decided would be mislabeled as mileage-balanced.

`carChoice` only ever reorders items 5 & 6 against each other; every other item in the key (shift cost, preferred car, slack, continuity) ranks above both regardless of mode, and golden fixtures (which carry no `carChoice`, hence `spread`, and no `mileageKm`) are unaffected either way.

```
mileageVal(car) = (car.mileageKm ?? 0) + kmAssignedToThisCarSoFarInThisSolve(car)
```

`kmAssignedToThisCarSoFarInThisSolve` is a running per-car total the greedy pass accumulates as it places round trips and relay pairs (never reset mid-solve): a round trip adds `2 × destination.distanceKm` (there and back, both ends at home); a relay pair's two legs each add `1 × destination.distanceKm` on their own ride row, totalling the same `2×` as a round trip to the same place. A destination with no `distanceKm` (unknown/free-text) contributes `0`. This is why, given two requests to the same destination on different days with two otherwise-interchangeable cars, the *first* is an ordinary tie (both cars start level) but the *second* can end up on the other car — whichever is now less loaded. Multi-day series placement (§3.16) does not use or update this total: it is all-or-nothing on one car already, so there is nothing left for a tie-break to decide between, and a "day" leg's `originId === destinationId` means "parked away between legs", not "round trip", so the same `2×`/`1×` reasoning does not apply there.

When `mileageVal` genuinely was the deciding factor — every earlier key field tied and mileage (or the in-solve total derived from it) did not — the assignment's `reasonCode` is `CAR_BALANCED_MILEAGE` instead of the ordinary `PLACED_PREFERRED`/`PLACED_SHIFTED` (§3.13); when a car's mileage lost only to some earlier field (a real shift-cost or continuity difference, say), the ordinary reason still applies — the Sadran only ever sees "balanced for mileage" when that is genuinely why this car was picked. The bounded improvement pass (§3.10) never treats mileage as a reason to relocate anything (it only relocates to satisfy a higher-priority unmet request) and clears a relocated ride's stale `CAR_BALANCED_MILEAGE` flag if the relocation moves it to a different car, since that move was decided for capacity, not mileage.

When no car in the input carries `mileageKm` (the common case until `car_mileage_totals` is wired up for a department, or any input built without it), `mileageVal` is `0` for every car and the key behaves exactly as it did before this field existed — golden fixtures are unaffected. The owner's decision (A12, 2026-09-14): this is a visible reason only, never a coercion — moving a mileage-balanced ride to a different car on the board triggers no extra confirmation.

#### 3.6.3 Retry passes (2026-10-05)

A placement can change where a car is (a `one_way` / relay leg, a chauffeur ride, a fixed-ride chain), which makes a request that starts at that place placeable although it was tried — and failed — earlier. After the first ordered pass, `runGreedy` therefore re-runs the still-unmet units in the same `(−score, submittedAtMs, id)` order with the same placement routines, repeating until a pass places nothing new (every non-final pass places at least one unit, so at most `units.length` passes). The location chain, end check, buffer, seat and luggage rules are unchanged; automatic placement keeps the full turnaround (a 15-minute gap after a one-way arrival stays unmet). Because retries run before suggestions, a request placeable at its own window is never reported unmet, and `shiftBeyondFlex` never emits a 0-minute shift. Test: `__tests__/retryPasses.test.ts`.

### 3.7 Flexibility search (`flex.ts`)

```ts
export function bestPlacementWithinFlex(tl: CarTimeline, u: Unit): Placement | null
```

For each free gap `[g1, g2)` of the car **whose location equals the leg's origin**, the feasible region is `dep' ∈ [max(flexDep.lo, g1), flexDep.hi]`, `ret' ∈ [flexRet.lo, min(flexRet.hi, g2 − buffer)]`, with `ret' − dep' ≥ minDurationSlots`. The minimal-shift point is `dep' = clamp(D, …)`, `ret' = clamp(R, …)` — O(1) per gap, no enumeration of the 96×96 shift pairs. If the duration constraint fails after clamping, the region is empty for that gap (both bounds are already the closest to the preferred). Across gaps and cars, order by `shiftCost`, then earlier departure, then the car key. For `durationFixed` legs the same computation runs in one dimension. For a relay pair the out-leg is placed first in a home gap, then the back-leg in the resulting away gap (`[out.end, next block)`), minimizing the summed shift. Beyond-flex search (§3.11) is the same function with the intervals widened by `beyondFlexMaxMinutes`.

### 3.7a Window requests — `durationLocked` (REQUIREMENTS §13.112 c, `flexibility.ts`, `merge.ts`)

"N hours somewhere between A and B" is a single-day `keep` round trip whose block `[D, R)` (`D = A`, `R = A + N`) has **later-only** flexibility `B − R` on both ends. `Request.durationLocked` (set by `buildSolverInput` from `requests.duration_locked`; honoured only for `tripType === 'round_trip'`, `NormalizedRequest.durationLocked`) means the block moves as **one piece**: wherever the solver shifts the request both ends move by the same `s`, so `end − start` never changes.

- **Placement** (`bestPlacementWithinFlex`, also the freed-slot, improvement-pass relocation, ejection and `shiftBeyondFlex` paths): for a locked `both` leg the per-gap feasible region is the single shift range `s ∈ [max(flexDep.lo − D, flexRet.lo − R, g1 − D), min(flexDep.hi − D, flexRet.hi − R, g2 − R)]` (`flexDep/flexRet` already clipped to the day, `widen` applied as in §3.11); the chosen `s` is the one closest to 0, `cost = 2·|s|`. Empty range → no placement in that gap (never a shorter or longer ride). The ordinary (unlocked) `both` formula clamps each end on its own and so can never slide a block (note 12); a window request therefore *can* be placed later in a gap the nominal block does not fit.
- **Improvement pass** (`closeGapSameCar`) already shifts both ends of each ride by the same amount, bounded by `min(start − flexDep.lo, end − flexRet.lo)` / `min(flexDep.hi − start, flexRet.hi − end)`, so the lock holds there unchanged; property test `durationLock.test.ts` asserts it end to end.
- **Merge** (`findMergeHosts`): a locked *host* never takes a merge that adds driving (the block would grow; SQL `_merge_check` refuses it with `merge_window_locked`), and when its guest-time shift is needed it shifts as one block (`s` that satisfies both guest legs and its own flexibility). A locked *guest* must get at least its block of time between boarding and alighting (`guestEnd − guestStart ≥ N`), and only a `both` merge qualifies. SQL has no guest-time check at all (the Sadran decides), so the guest rule is a solver-side suggestion filter only.
- Series, one-way, `drop_off` (and its `#out`/`#ret` split) and relay legs ignore the flag; a fixed ride serving a window request is not a host-growth blocker in the solver (it carries no lock; SQL decides when the Sadran acts).

### 3.8 Merge candidate detection (`merge.ts`)

```ts
export function findMergeHosts(guest: NormalizedRequest, leg: LegSide, rides: Assignment[], ctx): MergeCandidate[]
```

Merging is **per leg**: a `both` guest needs a host whose ride covers both directions (a `keep` ride); an `out` guest (one-way `passenger`, or the out leg of a split round trip) needs a host ride whose out leg goes there — a `keep` ride's outbound, a relay out-leg ride, or a chauffeur drop-off; a `return` guest needs a host coming back from there. A ride `h` (solver or fixed, including temporary-car owner rides) hosts guest `g` on leg `L` iff:

- **Cheapest insertion (REQUIREMENTS §13.95 H1, 2026-10-05; replaces the multi-stop route match, the same-origin filter and the zone/detour fallback).** For each merged direction (`out`: boarding = `g.originId`, alighting = `g.destinationId`; `return`: boarding = `g.destinationId`, alighting = `g.originId`; `both` = both directions on a `both` host) the guest's boarding and alighting places are inserted into `h`'s leg route (`legRoute()`, `travelBetween()`, `stopMinutes` dwell per inserted stop) where they add the least driving. A place already on the route is used as is (never duplicated). Valid only when (a) boarding is **strictly before** the route's final node (a guest boarding at `h`'s final destination — Haifa → Afula on a home → Haifa host — is refused) and alighting is after boarding and at or before the final node, and (b) the added driving on each leg is ≤ `config.detour.maxMinutes` and, when every hop's distance is known, ≤ `maxKm`. Different origins are allowed (the guest boards at a bus station on the way); an unknown pair falls back to `defaultTravelMinutes`, which normally exceeds the limit.
- **Host window (H1):** the new window is `[S − ceil(addedOut/15), E + ceil(addedReturn/15)]` — the ride **starts earlier** by the added out-leg driving and **ends later** by the added return-leg driving; the base request's own times (`S`, `E`) are kept. The candidate/`Suggestion.merge` carry the new `window`, `hostWindowBefore` (only when it changed), `addedOutMinutes`/`addedReturnMinutes` (only when > 0) so the UI can say "leaves at … instead of …". The extended window must be free on the host car (`CarTimeline.isFree` with the host's own block lifted), fixed hosts included (a fixed ride is changed only through consent, never by the solver).
- **Time compatibility:** the guest's ETA at its boarding place (`out`: `S' + arrival(boarding)`, `S'` = new start) / at its alighting place (`return`: `E' − tail`) must lie in its flexibility. If not, and `h` is a non-fixed `both` host, shift `h` within its own flexibility to the nearest point that works (`hostShift`), re-checking the extended window on the car.
- **Seats:** `fits(car_h, sum(h.passengers on leg L, g.passengers))` — per leg, §3.3.
- **Luggage:** if `h.luggageCount + g.luggage > 0` then `luggageCapacity(car_h) > 0` (yes/no, no count cap).

`MergeCandidate`/`Suggestion.merge` always carry `boardAtLocationId` (the guest's boarding place) — informational, for the UI/proposal.

`cost = addedMinutes(out + return) + shiftCost(g) + shiftCost(h)` (`detourMinutes` = the larger per-leg detour); `confidence = 1 − 0.4·detour/maxDetour − 0.1·(guests already in h) − shiftCost(g)/480`. The proposed driver is the host's driver unless the host request has `needsCarAtDestination = false` and the guest has `true`, in which case the guest is proposed as driver (REQUIREMENTS §13.9 allows the Sadran to set another driver). The guest's leg is recorded with `carMode = 'passenger'`.

Merges are never applied automatically. Two lists are produced: merges for unmet requests (as `Suggestion`) and `mergeOpportunities` between two *assigned* rides, ranked by freed car-slots, for the Sadran's information.

### 3.9 Split legs (`split.ts`)

> **Superseded for `drop_off` (REQUIREMENTS §13.94):** a drop-off with a pickup is split before solving (§1.3a), so this suggestion is only reachable for an explicit `round_trip` with `needsCarAtDestination = false`, which the bridge never produces. The text below is kept for that case.

For an unmet round trip with `needsCarAtDestination = false`: each leg is resolved independently to `passenger` (a host per §3.8) or `relay` (a car free at the leg's origin for `travel` slots, which — for the out leg — leaves the car at the destination and therefore needs a relay back-leg the same day: the requester's own return leg as `relay`, or another member's paired back-leg). Combinations tried, in order: passenger/passenger (two hosts `X`, `Y`; `X = Y` is a plain merge and is reported as such), relay/passenger (the requester drives out and leaves the car — only if another relay back-leg from that destination pairs with it, §3.6.1), passenger/relay (the requester drives home a car that a relay out-leg left there), relay/relay (self-pair, car parked at the destination in between). Passenger fit is checked per leg, so a family that rides out with X can still fit even if X picks up others on the way back. `cost = shiftCost + detour_X + detour_Y (+ idleSlots for relay legs)`, `confidence = 0.6 · min(conf_X, conf_Y)` for two consents; relay legs need no consent beyond the declared flexibility and count `conf = 1`. The result is one `splitLegs` suggestion whose two entries carry `carMode` (`passenger` → `merge` proposal leg, `relay` → applied directly by the board).

### 3.10 Bounded local improvement (`improve.ts`)

Goal: serve an unmet unit by **relocating** already-placed solver rides within their declared flexibility (consent-free per REQUIREMENTS §13.3). Fixed rides never move. A relay pair relocates as one unit (both legs move to the same target car); relocations keep every car's location chain valid (`tl.add` rejects a block whose origin does not match).

```
budget = config.improvementBudget
for u in unmet sorted by compareUnitsByPriority (score desc, then submittedAtMs asc, then id — same comparator as the greedy pass, §3.6):
  perReq = config.perRequestBudget
  for car in cars fitting u.passengers, sorted by id:
    blockers = rides on car overlapping u's flexible envelope (fixed → skip car)
    if blockers.length > 2: continue
    for each blocker b (depth 1), then each pair (depth 2):
      for target in cars sorted by id (including car itself):
        p = bestPlacementWithinFlex(tl[target] minus b, b); budget--, perReq--
        if p and then bestPlacementWithinFlex(tl[car] minus blockers, u):
          apply relocation(s) + place u; record reason; goto next u
        if budget == 0 or perReq == 0: stop
```

The search is depth ≤ 2, at most 2 blockers, and hard-capped by two counters; `stats.budgetExhausted` reports when a cap was hit. A relocated blocker's final `reasonCode`/`reason` is recomputed from its new `shift` exactly like any other placement (`PLACED_PREFERRED`/`PLACED_SHIFTED`, §3.13) — the Hebrew text does not name the beneficiary; `stats.relocations` counts how many placements were moved this way. **Displacement** — ejecting a lower-priority placed ride to serve a higher-priority one — is never done automatically (REQUIREMENTS §7.1, §13.19); the greedy order already serves higher scores first, and when the improvement pass finds a solution only by ejecting, it emits it as a `shiftWithinFlex` suggestion with non-empty `relocations` (the ejected ride listed with `toCarId = ''`) for the Sadran to decide **before publish**. After publish `solve()` is never run automatically and the live helpers (§5.2) never relocate or eject anything.

### 3.11 Suggestion generation (`suggest.ts`)

For each remaining unmet request, in REQUIREMENTS §7.1 order:

1. `shiftWithinFlex` — only reachable via relocations the improvement pass declined to apply; otherwise absent.
2. `merge` — from §3.8, per leg, up to 3 hosts. For a one-way `passenger` leg this is the primary suggestion.
3. `shiftBeyondFlex` — `bestPlacementWithinFlex` with intervals widened by ≤ 2 h; `confidence = 0.5 − shiftCost/480`. For a relay leg that would pair if one side moved beyond its flexibility, the suggestion carries `pairsWithRequestId` (§3.6.1).
3a. `chainOneWay` (new, REQUIREMENTS §13.105 a) — for an unmet explicit `one_way` request `X -> D`: an assignment that ends at X (`destinationId = X`, `originId <> destinationId`, so the car stands there) on a shared car that fits the request. Window = the request's own length starting at `max(departure, ride end + buffer)`, at most `beyondFlexMaxMinutes` after the stated departure, inside the day, with `CarTimeline.isFree(window, X, undefined, D)`. Smallest shift wins, ties by ride id; `{ carId, window, shift, afterRideId, afterRequestId? }`, `cost = shift minutes`, `confidence = 0.6 − shift/480` (min 0.1). Never automatic. Reason `SUGGEST_CHAIN_ONE_WAY` (names the other member) or `SUGGEST_CHAIN_ONE_WAY_ANON` (when the other member's name is not in the input).
4. `splitLegs` — §3.9, only for round trips with `needsCarAtDestination = false`.
4a. `changeOrigin` (new, REQUIREMENTS §13.93, §1.3a, 2026-10-04) — a car free for the request's whole preferred window at another place it already occupies; `{ carId, originId, window }`, mapped to proposal type `origin` (§3.15). Applies only to the trip types the SQL `origin` proposal can place through `try_auto_approve` — `round_trip`, `one_way`, and `drop_off` with a pickup (a one-leg `drop_off` is served by pairing/chauffeur rides, never by "take the car from Y"); for `one_way` the candidate also passes the placement end check (the car's next ride must start at the destination, or there is none).
5. One-way legs without a host or a partner (REQUIREMENTS §7.1 item 5) — reached only by a `drop_off` relay leg §3.6.1a could not heal (no car had room for both windows), or an unmet `one_way` leg (§1.3a: same shape, reused suggestion ladder, "as a drop-off it would fit"); a healed leg is placed and never enters this ladder. In this order:
   - `convertToRoundTrip` — for an unpaired `relay` **out** leg: a shared car is free from `H` for `[D, ret)` where `ret` is the **latest** slot before the car's next occupancy that day (minus buffer, capped at `dayEndSlot`) and at least `D + 2·travel`; the requester would keep the car and bring it back by then (consent; `confidence = 0.4`).
   - `chauffeur` — **hidden for the pilot (REQUIREMENTS §13.117 a, R7B2): produced only when `config.chauffeurSuggestions` is true, which the bridge never sets.** For any one-way leg (`passenger` without host, `relay` without partner): offered only when it is actually possible (owner, 2026-09-14; gated in `suggestions.ts` via `chauffeurLoad()` from §3.3) — some shared car is free for the whole §1.2 chauffeur window, tried at the leg's origin (drop-off) then its destination (pickup — §1.3a, owner follow-up 2026-10-04, `chauffeurCandidates()`; `H` for every legacy home-origin leg) **and** its seat configuration fits `chauffeurLoad(nr.passengers)` (the requester's load plus one adult for the volunteer); the first qualifying car/candidate in the existing deterministic order is used, otherwise no `chauffeur` suggestion is emitted for that request. When one qualifies, the request is shown as **needs a driver** (`stats.needsDriver`), the Sadran assigns a volunteer; `confidence = 0.5`. `volunteerCandidateMemberIds` lists members already driving that day with no overlapping ride, sorted by id.
6. `externalHint` — `cab` if single leg or occupancy ≤ `cabMaxMinutes` (90) and `distanceKm ≤ 30`; `rental` if occupancy ≥ `rentalMinHours` (30, spans days); `publicTransport` if `public_transport_score ≥ ptMinScore` (0.6).
7. `deny` — always present, last, with the blockers listed in the reason.

### 3.12 Post-conditions

Before returning, `assertInvariants(output)` checks no-overlap per car (including buffer and maintenance), seat fit for every ride (per leg, +1 adult for chauffeur rides), every request appears exactly once (assignment, unmet, or servedByFixed), fixed rides unchanged, **location chain per car** (`destinationId` of ride *n* = `originId` of ride *n+1*, first ride starts at `car.startLocationId ?? home`), temporary cars only `base → base` (REQUIREMENTS §13.93: `car.baseLocationId ?? home`), and every `PLACED_RELAY_PAIR` out-leg paired with a back-leg on the same car. **Retired 2026-10-04 (REQUIREMENTS §13.93, §1.3a):** the "every shared car home at every `dayEndSlot`" check is gone — a car may legitimately end any day away from home; only `WARN_CAR_AWAY_AT_WEEK_END` (a warning, not an invariant) flags it away from its base at week end. The relay-pairing check is scoped to `reasonCode === 'PLACED_RELAY_PAIR'` specifically (not every `carMode: 'relay'` leg) — an explicit `one_way` trip type (§1.3a) also places a single `relay`-mode leg, by design with no pairing obligation. A violation throws `SolverInvariantError` — the caller shows an error and keeps the previous draft.

### 3.13 Explainability

Every assignment, unmet record and suggestion has a `reasonCode` and a Hebrew `reason` rendered by `reasons.ts` from a template plus params (car name, times, member names supplied via `input`). `reasons.ts` is the **only** file under `src/solver` that contains Hebrew (CLAUDE.md hard rule 3): it also holds the rule descriptions shown in the admin UI (`RULE_<TYPE>_DESC`) and the `PolicyParamsError` messages, keyed by code. Examples:

| Code | Hebrew template |
|---|---|
| `PLACED_PREFERRED` | `שובץ ל{car} בזמן המבוקש` |
| `PLACED_SHIFTED` | `שובץ ל{car} עם הזזה של {dep} דק' ביציאה ו-{ret} דק' בחזרה, בתוך הגמישות שהוצהרה` |
| `PLACED_RELAY_PAIR` | `שובץ ל{car}: {member} נוהג/ת ל{dest} ב-{dep} ומשאיר/ה את הרכב; {partner} מחזיר/ה אותו ב-{ret}` |
| `PLACED_SERIES` | `שובץ/ה כחלק מבקשה רב-יומית ל{car} ({index}/{count})` |
| `CAR_BALANCED_MILEAGE` | `נבחר {car} לאיזון קילומטראז' בין הרכבים` (§3.6.2 — only when mileage genuinely decided the car) |
| `PLACED_NEEDS_DRIVER` | `שובץ ל{car} ללא נהג/ת קבוע/ה; דרוש/ה מתנדב/ת או אורח/ת שיסיע/תסיע` (§1.3.10a: a non-driver's driverless round trip) |
| `PLACED_PICKUP_FROM_CAR_AT_X` | `שובץ ל{car}: הרכב כבר ב{place}; המבקש/ת נוהג/ת בו הביתה ומגיע/ה ב-{ret}` (§3.6.1c, REQUIREMENTS §13.105 b) |
| `SUGGEST_CHAIN_ONE_WAY` / `SUGGEST_CHAIN_ONE_WAY_ANON` | `chainOneWay` suggestion text (§3.11 item 3a); the `_ANON` form omits the other member |
| `PLACED_CHAUFFEUR_NO_RETURNER` | `שובץ ל{car} כהסעה ל{dest} ({dep}–{ret}): לא נמצא/ה מי שמחזיר/ה את הרכב; דרוש/ה נהג/ת מתנדב/ת` (§3.6.1a: an unpaired relay candidate, placed as a standalone chauffeur ride) |
| `UNMET_NO_CAR` | text names the real cause (R2B11), same `reasonCode`: no shared cars (`UNMET_NO_CAR_NONE`), no car with enough seats incl. the driver (`_SEATS`), luggage (`_LUGGAGE`), no car at the origin (`UNMET_NO_CAR_AT_ORIGIN` text), else `אין רכב פנוי בחלון המבוקש; חוסמים: {blockers}` (never empty; `_BUSY` when no blocker is named). Identical suggestions from a split drop-off's two legs are listed once; `changeOrigin` never targets the request's own origin and tries every car gap; `convertToRoundTrip` requires the car at the leg's origin (R2B12) |
| `UNMET_ONE_WAY_STRANDS_CAR` | `יש רכב פנוי ב{origin}, אבל נסיעה בכיוון אחד ל{dest} תשאיר אותו שם והוא נדרש לנסיעה הבאה שלו; אפשר לשבץ יחד עם נסיעה חוזרת מ{dest}` (§3.6.1d, R8B14) |
| `UNMET_NEEDS_LARGE_TRUNK` | `צריך רכב עם תא מטען גדול` (large luggage and no shared car has a big trunk) |
| `UNMET_SERIES_NO_CAR` | `אין רכב פנוי לכל ימי הבקשה הרב-יומית ({index}/{count})` |
| `UNMET_NO_RELAY_PARTNER` | `אין מי שיחזיר/יביא את הרכב מ{dest}: לא נמצא/ה נהג/ת שיחזיר/ה אותו, והנסיעה בכיוון אחד תשאיר אותו שם` (no day-end wording, REQ §13.93) |
| `UNMET_NEEDS_DRIVER` | `אין נסיעה מתאימה להצטרף אליה; דרוש/ה נהג/ת מתנדב/ת להסעה ל{dest} ב-{dep}` |
| `SUGGEST_MERGE` | `הצטרפות לנסיעה של {host} ל{dest} ביציאה {dep} ובחזרה {ret}, ללא סטייה` |
| `SUGGEST_BEYOND_FLEX` | `הזזה של {dep} דק' מעבר לגמישות שהוצהרה — דורש הסכמה` |
| `SUGGEST_ROUND_TRIP` | `במקום להשאיר את הרכב ב{dest}: לקחת אותו הלוך ושוב ולחזור ב-{ret} — דורש הסכמה` |
| `SUGGEST_CHAUFFEUR` | `הסעה: נהג/ת מתנדב/ת מסיע/ה ל{dest} ב-{dep} וחוזר/ת עם הרכב (כ-{minutes} דק'); הסדרן/ית משבץ/ת נהג/ת` |
| `SUGGEST_CHANGE_ORIGIN` | `יש רכב פנוי ב{origin} לאורך כל החלון המבוקש; ניתן להציע יציאה מ{origin} עם {car} — דורש הסכמה` (new, REQUIREMENTS §13.93, §1.3a) |
| `SUGGEST_DENY` | `לא נמצא פתרון; ניתן לדחות עם הסבר` |
| `UNMET_NO_CAR_AT_ORIGIN` | `אין רכב פנוי שנמצא ב{origin} כדי לצאת משם ל{dest}` (new, REQUIREMENTS §13.93: an unmet explicit `one_way` leg) |
| `UNMET_FREE_TEXT_ORIGIN` | `נקודת היציאה היא טקסט חופשי ולא מקום מוכר; לא ניתן לשבץ נסיעה ממנה אוטומטית` (new, REQUIREMENTS §13.93) |
| `WARN_FIXED_RIDE_CONFLICT` | `נסיעה קבועה חופפת או צמודה מדי לנסיעה קבועה אחרת באותו רכב` (QB1) |
| `WARN_CHAIN_BROKEN` | `נסיעה קבועה מתחילה במקום שהרכב אינו נמצא בו בפועל` (new, REQUIREMENTS §13.93 — replaces `WARN_FIXED_RIDE_LOCATION_MISMATCH`) |
| `WARN_CAR_AWAY_AT_WEEK_END` | `{car} מסיים/ת את השבוע ב{place} ולא בבסיסו/ה` (new, REQUIREMENTS §13.93 — replaces `WARN_CAR_AWAY_AT_DAY_END`) |

#### 3.13a Names, never ids

A template var is never an id (owner 2026-10-05, G1: "חוסמים: 00000000-…042"). Names come from the input through `src/solver/names.ts`: `Destination.name` -> `placeName(input, id, freeText?)` (else the request's `destinationText` / `originText`, else `''`), `Car.name` -> `carName(cars, id)` (`UNMET_NO_CAR`/`SUGGEST_DENY` blockers), `Request.memberName` -> `memberName(input, memberId)` (`PLACED_RELAY_PAIR` member/partner), and `rideHostLabel()` for `SUGGEST_MERGE` `{host}` (the host ride's driver name, else its car name, else `''`). The bridge fills them (`buildSolverInput`: `destinations.name`, `requests.requester_full_name` -> `memberName`, `destination_text`/`origin_text`; `on-ride-cancelled` maps `destinations.name`); a caller that omits them gets empty text, never a uuid. `__tests__/reasonNames.test.ts` solves a representative week with uuid ids and asserts no rendered text matches a uuid regex.

### 3.14 Determinism

No randomness, no clock reads (`elapsedMs` is measured by the caller-supplied `now?: () => number` for stats only). Every sort uses a total-order comparator that ends in an `id` comparison. Inputs are sorted by `id` at normalization so `Map` iteration order is stable. Floating-point scores are summed in rule-registry order after rounding rule values to 6 decimals.

### 3.15 Suggestion kind → proposal type (canonical mapping)

The solver emits `Suggestion.kind`; the board turns an accepted suggestion into either a direct board edit or a `proposals` row (`proposal_type` enum, `DATA_MODEL.md` §3.8). This table is the single definition; `DATA_MODEL.md` (proposals) and `UX_FLOWS.md` §4.3 (composer) reference it.

| `Suggestion.kind` | `proposal_type` | Consent | Payload / notes |
|---|---|---|---|
| `shiftWithinFlex` | **none** — applied directly to the draft (board action **החל**) | none beyond the declared flexibility (REQUIREMENTS §13.3); the member is informed at publish | includes `relocations` of other rides, all within their own flexibility; a relocation with `toCarId = ''` is a displacement the Sadran must confirm (pre-publish only) |
| `shiftBeyondFlex` | `shift` | requester | `{depart_at, return_at}` from `window`; `pairsWithRequestId` is shown in the reason only |
| `merge` | `merge` | every member in the ride (REQUIREMENTS §7.3) | `{ride_id: hostRideId, role, legs: [{leg, ride_id, car_mode: 'passenger'}], detour_minutes}`; `proposedDriverRequestId` decides `role`; `leg` is `both` for round trips, `out`/`return` for one-way passenger legs |
| `splitLegs` | `merge` for the `passenger` legs; the `relay` legs are applied directly (**החל**) | requester + the hosts' members of the passenger legs | two entries: `legs: [{leg:'out', ride_id, car_mode}, {leg:'return', ride_id, car_mode}]`; a `relay` entry has no `ride_id` but a `car_id` |
| `convertToRoundTrip` | `shift` | requester | `{depart_at, return_at, trip_shape: 'round_trip', needs_car_at_destination: true}` — the request becomes a `keep` round trip if accepted |
| `chauffeur` | **none to the requester** — a Sadran task: **שבץ נהג/ת** creates the pinned chauffeur ride with the chosen volunteer as `driver_id` | the volunteer, informally (WhatsApp) — or formally via an optional `merge` proposal to the volunteer (`role: 'driver'`, `wa.chauffeur` text, party with `request_id = null`) | the request row gets `car_mode = 'chauffeur'`, `role = 'passenger'`; while unassigned the request stays `waitlisted` with reason `UNMET_NEEDS_DRIVER` ("needs a driver" state on the board) |
| `externalHint` | `external` | requester ("אסתדר בעצמי" → `external`; decline = stay waitlisted) | `{hint: 'cab' \| 'rental' \| 'public_transport', reason}`; the Sadran may also pick `private` manually; WhatsApp text `wa.external` |
| `chainOneWay` (new, REQUIREMENTS §13.105 a) | `shift` (no new proposal type) | requester (and nobody else: the earlier ride is untouched) | `{car_id: carId, depart_at}` from `window.start`; applying it runs `place_request_on_car` (one_way branch: the car must be at the request's origin then and its next ride must start at the destination). `afterRideId`/`afterRequestId` are shown in the reason only. A Sadran who prefers to place both legs by hand uses the existing board tools (drag onto the car) |
| `changeOrigin` (new, REQUIREMENTS §13.93, §1.3a) | `origin` (SQL enum value added by O3, own migration file) | requester (their origin is changing) | `{origin_id: originId, car_id: carId}` — applying it updates the request's `origin_id` and places it; shown to the Sadran only |
| `useAlternative` (new, REQUIREMENTS §13.112 a) | `alternative` (SQL enum value, own migration) | requester (it is the plan B they wrote themselves) | `{car_id: carId, return_car_id?: returnCarId, depart_at: departSlot, return_at?: returnSlot}` (cars + the member's two times; the places and the plan's own times are copied from the request's `request_alternatives` row by `create_proposal`). Offered after the main solve for an **unmet** `round_trip`/`one_way` request with `fallback = 'alternative'`; never placed, never auto-sent or auto-drafted; applying turns the request into the plan-B הקפצה (DATA_MODEL "Plan B and אסתדר") |
| `deny` | `deny` | requester acknowledges | `{reason}` with the blockers |

`shiftWithinFlex` never produces a proposal because the member already consented (REQUIREMENTS §7.1 item 1); `chauffeur` never produces a proposal to the requester because nothing changes for them except who drives; everything else needs an answer via `/p/<token>` or a Sadran-recorded answer.

#### 3.15a Plan B and "אסתדר" — `src/solver/alternative.ts` (REQUIREMENTS §13.112 a/b)

`Request.fallback?: 'none' | 'alternative' | 'manage'` and `Request.alternative?: { dropPlaceId, dropPlaceIsFreeText?, dropPlaceText?, arriveByMs, pickupMs? }` (the bridge maps them only for a `round_trip`/`one_way` request that is not a series and not already served by its plan B; `Request.servedByAlternative` is scoring-only). `solve()` = the main solve (`solveBase`) followed by `applyFallbacks()`, which never changes the main result:
- **`manage`**: the `externalHint` suggestions of that unmet request are dropped (a `deny` stays: the Sadran must refuse it explicitly).
- **`alternative`**: the plan B is tested as a drop-off against the board as the main solve left it (every placed ride a fixed block): one synthetic request `<id>~alt` (`tripType drop_off`, destination = the drop place, departure = `arriveBy` − the drive rounded up to the grid, no flexibility; with a pickup, `returnMs` = pickup + the drive back) goes through the same `solveBase` (drop-off split, chauffeur / needs-driver, car at the origin, turnaround). When every leg is placed the unmet request gains a `useAlternative` suggestion (before the external hints and the deny) with the leg car(s), `departSlot` and `returnSlot`. With a pickup from another place the pickup leg is a second synthetic drop-off (`<id>~altp`, origin = the pickup place, destination = the request's origin, leaving at the pickup time) solved in the same sub-solve; both must be placed (a free-text pickup place is never offered); the suggestion then has no `returnSlot` and `returnCarId` is the pickup car. Each plan B is tested independently; nothing is placed. A free-text origin, a series or a drop place equal to the origin never qualifies.
- **Fairness weight**: the fairness rule param `alternativeServedWeight` (default 0.1, 0..1, `rules/fairness.ts`, `alternativeServedWeightOf(policy)`) is how much of a served request a plan-B-served request counts: in `fairness_stats()` (SQL, granted hours) and in the policy score (`calculateProfileScores`: `served_priority_total` and the per-request `weight` that `assert_publication_scores` verifies). `score()` itself does not read it.

### 3.16 Multi-day series

The DB stores a multi-day request as one `requests` row per calendar day, sharing `series_id`, with `series_index` (1-based over the *whole* series) and `series_count` (its total length). The first leg departs at the member's own time and ends `23:59:00` that day; every middle leg runs `00:00 → 23:59:00`; the last leg runs `00:00 →` the member's own return time. The solver only ever sees the legs that fall inside the week being solved — a series may start mid-week and continue past Saturday (its last in-week leg ends `23:59` Saturday), or start Sunday `00:00` as a continuation of a series whose earlier legs were placed by a previous week's solve (first in-week leg has `series_index > 1`; the car is **not** at home at week start in that case — the mapper passes `Car.startLocationId` when it has that information, otherwise the car defaults to home and `assert_car_chain()` in SQL is the actual guarantee, REQUIREMENTS §13.57–58). Legs outside the current week are placed by SQL's `place_series()` after `apply_solver_result`, which pins them to the same car the solver chose.

**Hard rule:** all in-week legs of one series land on **one car**, **all-or-nothing**, and nobody else's ride is ever scheduled between two legs (the car sits parked at the destination overnight). This is enforced two ways: the greedy placement (below) checks the *composite* window spanning every in-week leg as a single free interval before committing any leg, and `CarTimeline` (`timeline.ts`) treats consecutive blocks sharing a `Block.seriesId` as needing **no buffer** between them (only a true overlap disqualifies), while the ordinary buffer rule still applies against every other booking at the outer edges of the whole series and everywhere else.

- **Types** (`types.ts`): `Request` gains optional `seriesId?: string; seriesIndex?: number; seriesCount?: number` (present together or not at all). `Car.startLocationId` (already existed, §2) is the hook for a continuation's car location. `Assignment` gains optional `seriesId?: string`, set on every leg's output row so the board/DB can group them.
- **Normalization** (`slots.ts`): a request with `seriesId` set never enters the ordinary `normalized` pool (so it is automatically invisible to relay pairing, merge, split, improve and suggestions — all of which only ever see `normalized`/`assignments` built from it). Instead `normalize()` groups such requests by `seriesId` into a `SeriesUnit { seriesId, seriesCount, destinationId, legs: SeriesLeg[], scoreProxy }`. Per leg, `originId`/`destinationId` (the *car's* location at the leg's start/end) are `home` only at the true global first/last leg (`seriesIndex === 1` / `=== seriesCount`); every other leg's origin and destination are the series' own destination (the car parked there). **Flexibility only ever applies to the leg that is also the true global first/last leg** — `flexDeparture` on the leg with `seriesIndex === 1`, `flexReturn` on the leg with `seriesIndex === seriesCount`; every other leg's day-boundary timestamp (`00:00`/`23:59`) is fixed, `[D, D]`/`[R, R]`. `scoreProxy` is a normal round-trip `NormalizedRequest` built from the first in-week leg's own request row via the same code the ordinary round-trip branch uses, so the policy engine scores a series exactly like any other request — **the series unit is ranked by the first in-week leg's score alone** (peopleServed etc. do not sum across legs, unlike a relay pair, §3.6.1). Normalization never throws: a leg with unusable timestamps degenerates to a zero-length window (never fits any car, surfaces as `UNMET_SERIES_NO_CAR`).
- **Placement** (`greedy.ts`): a `Unit.kind === 'series'` (alongside the existing `'single'`/`'pair'`, the same precedent as relay pairs) is tried on every shared car, preferred car first is *not* special-cased beyond the ordinary soft `preference` key. Only the outer boundary can move: `trySeriesOnCar()` enumerates candidate departures for the global-first leg (if present in-week) and candidate returns for the global-last leg (if present in-week) — each within its own declared flexibility, sorted by distance from the preferred slot — and accepts the first composite window `tl.isFree({start: D, end: R}, firstLeg.originId)` that is free, minimizing total shift. Car choice key: `shiftCost → soft preference → slack (max over legs) → continuity (min over legs) → fragmentation of the composite window → car.id` (§3.6). On success, every leg is committed via `tl.add({..., overnightAck: true, seriesId})` — `overnightAck: true` because a series leg legitimately leaves the car away between legs (§1.3.9 is about a *lone* relay leg, not a whole series); on failure, the unit is pushed to `unmetUnits` untouched (the same fallback path that already treats `kind !== 'single'` as immovable, so `improve.ts` never attempts to relocate a series or use one as a blocker's replacement).
- **Unmet / suggestions** (`index.ts`): a still-unmet series unit is expanded into one `UnmetRequest` per leg — `reasonCode: 'UNMET_SERIES_NO_CAR'`, `suggestions: []`, `blockers: []` — bypassing `buildSuggestions()` entirely (REQUIREMENTS §7.1's suggestion ladder does not apply: there is no meaningful shift/merge/split for an immovable multi-day booking). `buildHostRides()` (`merge.ts`) skips any assignment with `seriesId` set, so a series ride is never offered as a merge host either.
- **Live phase** (`live.ts`): `matchFreedSlot()` filters series requests out of its candidate pool — SQL's `try_auto_approve_series` (owned by the DB layer) handles a series' initial placement, since all-or-nothing placement across every leg's day needs the whole-series view this single-slot helper deliberately doesn't have.
- **Invariants** (`invariants.ts`): beyond the ordinary per-car overlap/location-chain check (which, via the same `seriesId`-aware buffer exemption, already accepts contiguous series legs), a dedicated pass checks every series' legs share one `carId`, are contiguous (`legs[i].window.end === legs[i+1].window.start`) and location-chained (`legs[i].destinationId === legs[i+1].originId`) — `SERIES_MULTI_CAR` / `SERIES_NOT_CONTIGUOUS` / `SERIES_LOCATION_BROKEN`.
- **Reason codes** (`reasons.ts`): `PLACED_SERIES` (`שובץ/ה כחלק מבקשה רב-יומית ל{car} ({index}/{count})`), `UNMET_SERIES_NO_CAR` (`אין רכב פנוי לכל ימי הבקשה הרב-יומית ({index}/{count})`).
- **Mapper** (`src/features/solverBridge/buildSolverInput.ts`): forwards `requests.series_id/series_index/series_count` (columns already present in the generated Supabase types) as `seriesId/seriesIndex/seriesCount`. `Car.startLocationId` is **not** populated by this mapper — it has no "car's location before the week" input wired through; a future caller with that lookup can add it. Absent it, a continuing series' car defaults to home per `timeline.ts`, and the actual safety net is SQL's `assert_car_chain()`, not this mapper.

---

## 4. Policy engine

### 4.1 Rule interface and registry

```ts
// src/solver/rules/types.ts
export interface RuleContext<P> {
  params: P; policy: Policy; stats: SolverStats;
  destinations: Record<string, Destination>;
  batch: { requests: NormalizedRequest[]; size: number };   // for batch-relative rules
}
export interface Rule<P = unknown> {
  type: string;
  normalization: 'unit' | 'minmax';        // 'unit': raw already in 0..1 (clamped); 'minmax': scaled across the batch
  defaultParams: P;
  validateParams(raw: unknown): P;          // throws PolicyParamsError(code); Hebrew text rendered from reasons.ts
  describe(params: P): string;              // Hebrew for the admin UI, rendered via reasons.ts (RULE_<TYPE>_DESC) — no literal here
  score(ctx: RuleContext<P>, request: NormalizedRequest): number;   // raw value
}

// src/solver/rules/index.ts
export const ruleRegistry = {
  rideType, distance, publicTransport, peopleServed, fairness, submissionTime, flexibilityOffered, manualBoost,
} as const satisfies Record<string, Rule<any>>;
export type RuleType = keyof typeof ruleRegistry;
```

Five rule types (`distance`, `fairness`, `peopleServed`, `submissionTime`, `flexibilityOffered`) share the same single-numeric-param shape; their `validateParams` calls `validatePositiveNumberParam(raw, key, errorCode, { allowZero? })` (`rules/types.ts`) instead of repeating the object/finite/positive checks — `allowZero` is only set for `submissionTime`'s `latePenalty`, which may legitimately be 0.

### 4.2 Scoring

```ts
export function scoreRequests(input: SolverInput, batch: NormalizedRequest[]): Map<string, ScoreBreakdown>
// total(r) = Σ_i weight_i · norm_i(score_i(ctx_i, r))
```

Normalization runs per rule over the whole batch before weighting: `unit` clamps to `[0,1]`; `minmax` maps the batch min/max to `0..1` (all-equal → `0`). Weights may be negative. Unknown rule types in a policy produce a warning `UNKNOWN_RULE_TYPE` and are skipped, never a crash — the policy is data and may be newer than the code. `ScoreBreakdown` (per rule value, weight, contribution) is returned to the UI for the "why this order" panel.

### 4.3 Shipped rule types

| type | params | raw value |
|---|---|---|
| `rideType` | `{ weights: Record<string, number>; defaultWeight: number }` | `(weights[type] ?? defaultWeight) / max(defaultWeight, ...weights.values())`; `weights` accepts any string key (admin-defined `ride_types.code`, not a fixed set) — a type absent from `weights` (e.g. a code added after this policy version was saved) uses `defaultWeight` instead of scoring 0. Stored policies from before `defaultWeight` existed keep validating: a missing `defaultWeight` defaults to 5 |
| `distance` | `{ maxKm: number }` | `min(distanceKm / maxKm, 1)`; unknown → 0 |
| `publicTransport` | `{}` | `1 − publicTransportScore`; unknown → 0.5 |
| `peopleServed` | `{ cap: number }` | `min((adults + childSeats + boosters − 1) / cap, 1)`; for a request in a relay pair (§3.6.1) the people of both legs are summed, so a pair outranks a lone request of the same type |
| `fairness` | `{ lookbackWeeks: number }` | `stats.fairness[member].deficit` (0..1, computed by the caller from granted ride-hours in the lookback; fewer granted hours → higher score, no history → 0.5). Number of requests submitted is not used. `lookbackWeeks` default **3** (REQUIREMENTS §13.18); the caller passes it to `fairness_stats()` |
| `submissionTime` | `{ latePenalty: number }` | on time: `1 − 0.3 · rank/N` by `submittedAtMs`; late: `max(0, 0.7 − latePenalty)` |
| `flexibilityOffered` | `{ fullCreditMinutes: number }` | `min(totalDeclaredFlexMinutes / fullCreditMinutes, 1)`; `'day'` counts as 480 |
| `manualBoost` | `{}` | `request.manualBoost?.value ?? 0` |

"Late penalty" is thus part of `submissionTime` (a policy param, not a department setting); "manual boost" is an ordinary rule whose value comes from the request, so a Sadran boost only has effect if the policy includes the rule with a weight (default 2.0). `rideType.weights` is keyed by `ride_types.code`, which is admin-editable data, not a fixed set of five — the seed policy below happens to key it by `work`/`childcare`/`healthcare`/`errands`/`other` because that's what `supabase/seed.sql` ships in `ride_types`, but the rule accepts any code and falls back to `defaultWeight` for a code the policy doesn't mention (e.g. one added after this policy version was saved); `fairness.lookbackWeeks` is likewise policy data — default **3 weeks, per member**, no department setting (REQUIREMENTS §13.18; the caller reads it from the active policy and calls `fairness_stats(dept, week, lookbackWeeks)`, DATA_MODEL §7.3). This JSON is what `supabase/seed.sql` inserts as `policy_versions` v1 of the global default.

### 4.4 Example policy

```json
{ "id": "nevo-default", "version": 3, "rules": [
  { "type": "rideType", "weight": 1.0, "params": { "weights": { "healthcare": 10, "work": 8, "childcare": 8, "other": 5, "errands": 3 }, "defaultWeight": 5 } },
  { "type": "distance", "weight": 0.4, "params": { "maxKm": 60 } },
  { "type": "publicTransport", "weight": 0.3, "params": {} },
  { "type": "peopleServed", "weight": 0.3, "params": { "cap": 4 } },
  { "type": "fairness", "weight": 0.5, "params": { "lookbackWeeks": 3 } },
  { "type": "submissionTime", "weight": 0.2, "params": { "latePenalty": 1 } },
  { "type": "flexibilityOffered", "weight": 0.2, "params": { "fullCreditMinutes": 240 } },
  { "type": "manualBoost", "weight": 2.0, "params": {} }
] }
```

`supabase/seed.sql` inserts the `rideType` params without `defaultWeight` (a stored policy predating this field) — `validateParams` defaults a missing `defaultWeight` to 5, so it still validates and scores identically to the JSON above.

### 4.5 Adding a rule type (what `.claude/skills/add-priority-rule` automates)

1. Create `src/solver/rules/<type>.ts` exporting a `Rule<P>` object (type string, `normalization`, `defaultParams`, `validateParams`, `describe`, `score`). Add the Hebrew description template (`RULE_<TYPE>_DESC`) and any param-error message to `src/solver/reasons.ts`; the rule file itself contains no Hebrew.
2. Add one line to `ruleRegistry` in `src/solver/rules/index.ts`. `RuleType` widens automatically.
3. Add `src/solver/rules/__tests__/<type>.test.ts`: value range, `validateParams` rejection, a scenario where changing the weight changes the greedy order.
4. If the rule needs new input data (like `fairness` needs `stats`), extend `SolverStats` in `types.ts` and the caller's stats loader — the solver itself never fetches.
5. Add the type and its params form to the admin policy editor (outside `src/solver`; the editor reads `describe` and `defaultParams` from the registry).

No other file changes. The engine, the sort and the UI breakdown pick the rule up through the registry.

---

## 5. Re-solve semantics and live-phase helpers

### 5.1 Fixed inputs and "solve remaining only"

`fixedRides` (pinned, applied proposals, temporary-car owner rides) are copied to the output as `source: 'fixed'` and seeded into timelines; the requests they serve are excluded. The solver is stateless about request status — the caller decides which requests are open (`submitted`, `waitlisted`, `denied` if the Sadran wishes, `proposed` if it wants the fallback computed). "Auto-solve remaining" on the board is the caller passing every current draft ride as a `FixedRide { kind: 'pinned' }` (REQUIREMENTS §7.1: manual edits become pinned). A full re-run passes only real pins and supplies the previous draft as `previousAssignments` so continuity (§3.6 key 4) minimizes churn. Output never contains changes to fixed rides.

**Bridge contract for `rides.auto_relocation` (REQUIREMENTS §13.89, owner 2026-09-15; DB side already shipped in `supabase/migrations/20260915110000_car_chain_relocation_rides.sql`'s `assert_car_chain()` — decided here since no `ExistingRide`/new `FixedRide.kind` was needed):** `buildSolverInput` **omits** an unclaimed `rides.auto_relocation` row (`auto_relocation = true`, `driver_id is null`) from `fixedRides` entirely — `assert_car_chain()` itself already does the same thing when walking a car's chain (`where ... and (not auto_relocation or driver_id is not null)`), because the row carries no location fact the chain doesn't already have (the car's position is already fully determined by the preceding real ride's `destination_id`; the DB placeholder only exists so a member can claim it via `claim_ride_driver`). A **claimed** relocation (`driver_id` set) is an ordinary one-way `FixedRide` like any other and must be included as usual. The bridge marks the **real** fixed leg that left the car away (a pinned relay-out, or any leg whose paired return is only covered by an unclaimed `auto_relocation` row) with `overnightAck: fixedRideRow.overnight_ack_by !== null` — reusing the existing field for "Sadran acknowledged the car is not home at day end" (no type change needed); this only avoids a misleading `CAR_AWAY_AT_DAY_END` warning; `assertInvariants` already never throws for a day-end violation caused by a fixed ride (§3.12) either way. If the gap is still open when `solve()` runs again, either normal relay pairing finds a new real partner for it, or (when the gap belongs to a genuinely-unpaired relay candidate rather than a fixed-ride placeholder) §3.6.1a places an equivalent standalone chauffeur ride this run — either way the result is idempotent with what the DB's own `assert_car_chain()` would do on the next ride write (REQUIREMENTS §13.89: "cancels itself as soon as a real leg covers the gap"). `Request.canDrive` is `!profile.does_not_drive` (`supabase/migrations/20260915120000_non_driver_profiles.sql`) — the bridge reads the requester's `profiles.does_not_drive` column (already granted to `authenticated`, §2 mapper section).

### 5.2 After publish: no automatic solve

Post-publish the solver is **never** run automatically, and **nothing already placed is ever displaced or relocated** (REQUIREMENTS §13.19) — the two helpers below only *add* a ride into free time. Two small functions cover REQUIREMENTS §8:

```ts
export interface FreedSlotInput {
  car: Car; timeline: CarTimeline;             // car's remaining rides + maintenance, cancelled ride removed; location-aware
  freedWindow: Window; freedLocationId: string;   // where the car is during the freed window (home unless the cancelled ride was a relay leg)
  candidates: Request[];                       // waitlisted/denied, same department, not opted out (caller filters)
  destinations: Record<string, Destination>; policy: Policy; stats: SolverStats; config: SolverConfig;
  week: SolverInput['week']; homeLocationId: string;
}
export interface FreedSlotCandidate { requestId: string; window: Window; shift: { departureMin: number; returnMin: number }; score: number; reason: string }
export function matchFreedSlot(
  input: FreedSlotInput,
  opts?: { priorityRequestIds?: readonly string[] }, // REQ item 101 i: these ids rank before all others, then score/shift/id
): FreedSlotCandidate[];
```

A candidate qualifies if it is a **round trip** (`keep`), its flexible envelope intersects `freedWindow`, its passengers fit the car, luggage fits, and `bestPlacementWithinFlex(timeline, r)` finds a window whose gap location is `home` (the freed window may merge with adjacent free time — the timeline, not the freed window alone, decides). One-way requests are never freed-slot candidates (they need a partner, a host or a driver — REQUIREMENTS §13.64). Results are ordered by `(−score, shiftCost, id)`. The caller applies §8: one candidate → auto-assign and notify; several → push all and the Sadran; none → slot stays free. **Relay legs**: cancelling one leg of a pair does not create an offer at all — `cancel_ride` flags the partner leg for the Sadran (REQUIREMENTS §13.63); only when both legs are cancelled is the whole window at home freed and offered.

Auto-approve of a newly submitted request has **no TypeScript counterpart** — it is a SQL-only concern, `public.try_auto_approve(p_request_id uuid)` (defined in `supabase/migrations/20260907091500_rpc.sql`, redefined by `20260909093000_extend_auto_approve_and_waitlist.sql`, `20260910091900_link_auto_approve_to_waitlist_groups.sql` and, currently, `20260910099100_guard_internal_functions.sql`), called from inside `submit_request()` for a `published`/`live` week and a `round_trip` request (`20260910095400_gate_submit_request_upcoming_phase.sql`); a multi-day series leg goes through the separate `try_auto_approve_series()` instead. Its rules, read from the current SQL body:
- eligible only for `round_trip` requests currently `submitted` or `waitlisted`; locks the row (`for update`) so two concurrent attempts can't double-book.
- tries the request's `preferred_car_id` first (shared, active, seats fit, at home at the requested departure time, no overlap including the turnaround buffer), then falls back to any shared car meeting the same eligibility, ordered by `car.id`.
- on success: inserts a `confirmed`, pinned (`pin_reason = 'AUTO_APPROVED'`) ride, marks the request `assigned` / `AUTO_APPROVED_FREE_CAR`, and calls `assert_car_chain()` — the exclusion constraint and that function are the final arbiters, not this function's own overlap check.
- on failure: marks the request `waitlisted`; if the day is already published, `join_waitlist_group()` may fold it into a contested waiting-list group (REQUIREMENTS §13.75) instead of a plain `WAITLISTED_NO_CAR`.
- notifies the requester and the Sadran(s) either way (`auto_approved` / `waitlisted_request`).

It is exercised by `supabase/tests/hardening_semantics.sql`, `supabase/tests/notifications_semantics.sql` and `supabase/tests/rls_smoke.sql` (grep `try_auto_approve`); waiting-list/contested-group behavior built on top of it is covered by `supabase/tests/todo_board_semantics.sql`. There is no bundled or reference TypeScript implementation to keep in sync, and no request-form "will be approved immediately" preview reads this logic today. Likewise `matchFreedSlot` is called by the `on-ride-cancelled` edge function over candidates pre-filtered by the SQL `freed_slot_candidates()`; the outcome is written by `resolve_freed_offer()`. Edits of an assigned ride use `timeline.isFree(newWindow, ride.originId)` on the same car (with the old ride removed); otherwise the caller treats it as cancel + new request. "Car goes to maintenance": the caller re-runs `solve()` with only the affected requests open and everything else fixed.

### 5.3 "Open" is a caller-computed set, and it must agree with `fixedRides` (bug-fix note, 2026-09-07)

This section already says "the caller decides which requests are open" — the MAJOR BUG investigation (`docs/UX_FLOWS.md` §19, `docs/DATA_MODEL.md` §6.1 item 25) found a caller (`src/features/sadran/applySolve.ts`, formerly `solverRun.ts`) that computed "open" from `requests.status` alone, independently of which rides it had just built `fixedRides` from (`rides.is_pinned`). A request already `assigned`/`merged` by a **previous solve's own unpinned ride** was neither open (wrong status) nor fixed (its ride isn't pinned) — invisible to `solve()` in both directions, so a `'full'` re-solve deleted its ride without the solver ever being told to replace it. The invariant a caller must maintain, stated precisely: **every non-final request must be either fed to `solve()` as open, or served by an entry in `fixedRides`, never neither.** `applySolve.ts`'s `selectOpenRequests` now enforces this directly — "open" is *derived from* `fixedRides`' `servedRequestIds` (`!fixedRequestIds.has(r.id)`), not computed independently and hoped to agree. §7.2's property test 3 ("every open request appears exactly once in `assignments ∪ unmet`") already covers `solve()`'s own side of this; it cannot catch a caller-side bug like this one, because from the solver's point of view the request was simply never part of the input at all — this is why the fix is unit-tested at the caller (`applySolve.test.ts`) and with a DB-level invariant (`supabase/tests/solve_semantics.sql`), not inside `src/solver`.

Separately, `previousAssignments` (§2, §3.6 key 4) was defined in `types.ts` from the start but no caller ever actually populated it — `gatherSolverContext`'s `'full'` mode now builds it from the board rides it is about to treat as replaceable (the same rides it computes for the "re-solve the whole week" confirm dialog's diff), so a full re-solve prefers keeping each request's members on the same car instead of reshuffling everyone for no reason.

---

## 6. Complexity and performance budget

Let `R = 300` requests, `C = 15` cars, `K ≈ R/C ≈ 20–40` rides per car.

| Phase | Cost | Estimate |
|---|---|---|
| Normalize + score | `O(R · rules)` | < 5 ms |
| Relay pairing | `O(P log P)` per destination with `P` relay legs (sorted sweep) | negligible |
| Sort | `O(R log R)` | negligible |
| Greedy: preferred check | `O(R · C · log K)` | ~ 20k binary searches |
| Greedy: flex search | `O(R · C · K)` O(1) per gap | ≤ 180k gap evaluations |
| Merge detection | `O(U · R)` with zone pre-filter (`Map<zone, rides[]>`) | ≤ 90k for 300 unmet worst case |
| Improvement | bounded by `improvementBudget` (5000 placements) | ≤ 5000 · O(K) |
| Suggestions | `O(U · C · K)` | as flex search |
| Invariant check | `O(R log R)` | negligible |

Data structures: sorted interval arrays per car (`CarTimeline`, each block with start/end location), `Map<zone, Assignment[]>` for merge hosts, `Map<destinationId, {out[], return[]}>` for relay pairing, plain arrays sorted by id elsewhere. Expected runtime well under 1 s in a mid-range phone browser; the CI performance test asserts < 2 s on the 300×15 fixture to leave margin under the 10 s requirement. Memory is O(R + C·K).

---

## 7. Test plan (Vitest)

### 7.1 Unit test matrix

| Area | Cases |
|---|---|
| Pilot fix round P2 (§1.2, §3.6.1d, REQUIREMENTS §13.117) | `__tests__/pilotFixP2.test.ts`: no chauffeur suggestion unless the flag is on (the flag-on cases live in `suggestions.test.ts`); `chauffeurTotalSlots` 31 + 31 + 10 min = 5 slots and the solver's chauffeur ride lasts 75 min; two complementary one-ways (with the car's later ride at home) land on one car, each member driving, deterministic; a lone leg that would strand the car says `UNMET_ONE_WAY_STRANDS_CAR`, a leg with no car at its origin still says `UNMET_NO_CAR_AT_ORIGIN` |
| QA run 5 (§3.6.1c, REQUIREMENTS §13.105) | `__tests__/qaRun5.test.ts`: short own pair connects despite a contested wait (and a long one does not; `solve()` puts both legs on one car, requester drives); pickup from a car standing at X is one relay ride X -> home (driver = requester or companion, none without a driver on board, none when the car is elsewhere); `chainOneWay` suggestion with shift 15 min on the car that stays at X, absent beyond 2 h, never applied by the solver |
| `seats.ts` | exact match; dominance in one component only fails; booster ≠ child seat; empty configs never fit; slack picks the minimal dominating config; merged sum fits where singles fit but sum does not |
| `timeline.ts` | ride ending exactly at next start fails with buffer 30, passes with buffer 0; ride abutting maintenance needs buffer; gaps at week start/end; remove then re-add; **location**: after a relay-out block `locationAt` = destination, `isFree(w, home)` is false during the away gap and `isFree(w, dest)` is true; `add` rejects a block whose start location mismatches; `awayWindows()` reports the away gap |
| Seats (chauffeur) | chauffeur ride load = requests + (1,0,0): a 4-adult family fits a 5-seater as `keep` but not as `chauffeur`; per-leg check on a relay pair |
| Relay pairing | out 09:00 + back 12:00 same destination pair on one car and both are served; different `destination_id` (same zone) do **not** pair; back-leg earlier than out-leg end does not pair; back-leg on the next day does not pair (day end); a genuinely-unhealable unpaired out-leg (no car has room) is unmet with `UNMET_NO_RELAY_PARTNER` and suggestions `convertToRoundTrip`, `chauffeur`, …; pair ranked by the higher score; a round trip with `needsCarAtDestination=false` self-pairs when `keep` does not fit and leaves the car free at the destination for a third request's relay-back |
| Location / day end | a home-origin request cannot use a car parked away (rejected via `UNMET_NO_CAR`, the away car listed among the blockers); fixed ride with `overnightAck` away at day end passes invariants, without it emits `CAR_AWAY_AT_DAY_END`; temporary car never gets a relay leg |
| Unpaired relay candidate → chauffeur (§3.6.1a) | `__tests__/canDrive.test.ts`: an unpaired relay out-leg is placed as a standalone chauffeur ride `[D, D+2·travel+dwell)`, `originId = destinationId = home`, no `pairedRideId` (`stats.needsDriver` +1); an unpaired relay return-leg gets `[R−2·travel−dwell, R)`; no room on any car falls back to `UNMET_NO_RELAY_PARTNER` unchanged; two opposite legs at the same destination with an eligible driver each still pair into one relay pair (never two chauffeur rides); invariants pass in every case |
| Non-driver members (§1.3.10a) | `canDrive.test.ts`: a round trip is placed driverless (`PLACED_NEEDS_DRIVER`, `role: 'passenger'`) never as driver; unplaceable falls back to the ordinary `merge` suggestion; a one-way leg is a relay candidate whenever an eligible driver is on board (requester or a `drivingCompanionIds` entry) — paired → relay leg with that member as `driverMemberId`; unpaired → standalone chauffeur; no eligible driver at all → `passenger` (then `chauffeur`); a stored legacy `oneWayCarMode` is ignored entirely, for drivers and non-drivers alike |
| Chauffeur | occupancy = 2·travel + dwell (45 min travel, dwell 10 → 100 min → 7 slots); suggestion appears only when a shared car is free at home for that window **and** fits `chauffeurLoad(nr.passengers)` (gated since 2026-09-14, owner — `findChauffeurCar` in `suggestions.ts`); every car busy for the window → no suggestion; seats that don't fit the extra volunteer adult → no suggestion; deterministic car choice; `stats.needsDriver` counts it; passenger one-way with no host gets `chauffeur` before `externalHint` |
| DST | week fixture containing the March/October transition day with 92/100 slots: a "day" flexibility resolves to the correct bounds; no slot arithmetic crosses days incorrectly; `dayEndSlot` correct on both transition days |
| Flexibility | asymmetric windows (−0/+60): shift only later; return flex without departure flex; `minDurationSlots` rejects clamp results that collapse the ride; earliest minimal shift wins ties; a pair's back-leg shifts later within flex to meet the out-leg |
| Merge | same zone passes; detour 21 min fails at limit 20; time window intersection at the boundary slot; host shift within host flex; fixed host never shifts; luggage needs `large_trunk` (yes/no, any number on a large-trunk car); temporary car is never a merge target; one-way `passenger` out-leg merges into a relay-out ride and into a keep ride's outbound, never into a return-only ride |
| Split legs | `needsCarAtDestination=false` gets X/Y hosts; X = Y collapses to merge; per-leg seat check; **relay + passenger**: out as relay (paired with another member's relay-back) and return as passenger in Y's ride — the car is free for Y's partner in between |
| Improvement | depth-1 relocation frees a car; depth-2 pair; budget exhaustion sets `budgetExhausted` and leaves output valid; fixed blocker skips car; a relay pair relocates as one unit; a relocation that would break a location chain is rejected; an ejection is emitted as a `shiftWithinFlex` suggestion, never applied |
| Policy | each rule's value range; `minmax` all-equal → 0; unknown rule type → warning; changing `rideType` weights flips the greedy order in a 2-request/1-car fixture; manual boost overrides; late penalty demotes |
| Determinism | `solve(input)` twice → deep-equal; shuffled input arrays → identical output |
| Live helpers | `matchFreedSlot`: one/many/zero candidates, flex placement into merged gap, one-way candidates excluded, freed window away from home matches nobody, never relocates an existing ride |
| Performance | `perf-300x15.json` (seeded PRNG generator in `__fixtures__/gen.ts`): completes < 2 s, `budgetExhausted` may be true, invariants hold |
| Origins, trip types, cars stay put (§1.3a, REQUIREMENTS §13.93) | `__tests__/origins.test.ts`: `effectiveTripType()`/`originIdOf()`/`travelBetween()` pure-helper cases; an explicit `one_way` request places as a single relay leg with no pairing/chauffeur fallback; the `isFree` end-check rejects a one-way placement that would strand an already-seeded fixed ride, and the identical request places fine without that fixed ride (control); a `drop_off` leg from a non-home origin heals into a chauffeur ride wrapping that origin; "pick me up from Harish" (origin Harish, destination = home) heals into a chauffeur ride even with every car at home, using the pickup window `[D−t−dwell, D+t)` (owner follow-up 2026-10-04); a drop_off between two non-home places (neither is where the car is) stays unmet; a free-text origin is never placed (`UNMET_FREE_TEXT_ORIGIN`) even on an entirely free car; the `changeOrigin` suggestion fires when a car is free for the whole window at another place it occupies; a one-way to a place on Tuesday blocks a Wednesday round trip from home but not from that place, and a car whose `startLocationId` is non-home at week start serves a same-origin request directly. `__tests__/timeline.test.ts` additionally covers `isFree`'s `endLocationId` no-op case, `chainBreaks()` (recorded, not thrown) and `weekEndAway()` (null at base, non-null away, honors a non-home `baseLocationId`); `__tests__/merge.test.ts` covers the same-origin merge filter; `__tests__/invariants.test.ts` confirms the day-end invariant no longer throws and the relay-pairing check does not misfire on a `one_way` single leg. The shared golden fixture `supabase/tests/fixtures/one_way_pairing_cases.json` (home-origin legacy one-way legs, always `drop_off`) keeps passing unchanged (`oneWayPairingParity.test.ts`). |
| Multi-stop rides (§1.3b, REQUIREMENTS §13.93 "Multi-stop rides") | `__tests__/multiStop.test.ts`: `legRoute()`/`legRouteMinutes()`/`legRouteSlots()` with no stops (byte-identical to the plain lookup), with an out-stop, a return-stop only affecting the return leg, and a free-text stop (always `defaultTravelMinutes` on both adjoining hops); `stopEtas()` forward (out) and backward (return); `routeEtaAt()` at both endpoints, a stop, and an unknown/free-text location (`undefined`); a `one_way` relay window grows by the route vs. a no-stop control case on the same destination; both `chauffeurCandidates()` candidates (drop-off car-at-origin, pickup car-at-destination) with stops, via a genuinely unpaired relay-eligible leg; `findMergeHosts()`: a guest boarding mid-route (Binyamina → home joining a Haifa → Binyamina → home host) at the host's own ETA there, the same guest outside its own declared flexibility (no join), a reversed-order guest (home → Binyamina on that host, no join), and a free-text host stop (never matches). |

### 7.2 Property-based tests (`fast-check`)

Arbitrary inputs (1–12 cars, 0–120 requests, random configs, blocks, fixed rides):

1. No two rides on a car violate the buffer rule; no ride overlaps maintenance.
2. Every assignment's passenger sum (plus one adult for chauffeur rides) fits its car; luggage only on a large-trunk car (yes/no).
3. Every open request appears exactly once in `assignments ∪ unmet`.
4. Every solver placement lies inside the request's declared flexibility.
5. Fixed rides are returned byte-identical.
6. `solve` is idempotent on its own output when all assignments are passed back as fixed rides (zero changes).
7. Per car, the rides chain locations and every shared car is home at every `dayEndSlot` (unless an `overnightAck` fixed ride); every relay-out ride has a `pairedRideId` on the same car and day; temporary cars are only `home → home`.

### 7.3 Golden fixtures

`src/solver/__fixtures__/<name>.input.json` + `<name>.expected.json`, compared with `toEqual` (not snapshots, so diffs are reviewed): `basic-4x8` (§8 below, includes a relay pair), `dst-spring`, `merge-detour-edge`, `split-legs`, `relay-unpaired` (unpaired relay legs → `convertToRoundTrip` / `chauffeur`), `chauffeur`, `needs-car-false-relay-passenger`, `fixed-rides-only`, `all-unmet`, `perf-300x15`.

---

## 8. Worked example (fixture `basic-4x8`)

All rides on Monday; buffer **30 min**; chauffeur dwell 10 min; day end 23:59; policy of §4.4; fairness deficits: Yossi 0.2, Michal 0.9, Eitan 0.7, others 0.5; Noa's usual car is C3. Home location **H** = Nevo (zone `home`).

**Cars**

| Car | Seat configs | Features | Blocks |
|---|---|---|---|
| C1 Picanto | {4,0,0} {2,1,0} {3,0,1} | — | Mon 05:00–07:00 |
| C2 Octavia | {5,0,0} {3,1,0} {2,2,0} {4,0,1} | large_trunk | — |
| C3 Corolla | {5,0,0} {3,1,0} {4,0,1} | — | Mon 13:00–17:00 |
| C4 Staria | {7,0,0} {5,2,0} {4,2,1} {6,0,1} | large_trunk | — |

**Destinations**: Tel Aviv (zone TA, 55 km, 60 min, PT 0.7); Beer Sheva (BS, 40 km, 45 min, PT 0.5); Ashkelon clinic (ASH, 25 km, 30 min, PT 0.3); Binyamina (BIN, 35 km, **45 min**, PT 0.8).

**Requests**

| Id | Member | Type | Dest | Shape / mode | Window | Passengers | Flex dep / ret | Notes |
|---|---|---|---|---|---|---|---|---|
| R1 | Dana | Healthcare | ASH | round trip, keep | 08:00–12:00 | 1A | 0 / 0 | |
| R2 | Yossi | Work | TA | round trip, keep | 08:30–17:00 | 1A | ±30 / ±30 | |
| R3 | Noa | Work | BIN | **one_way_to, relay** | dep 09:00 | 1A | ±30 / — | leaves the car in Binyamina |
| R4 | Avi | Childcare | BS | round trip, keep | 13:00–15:30 | 2A+1CS | 0 / 0 | |
| R5 | Michal | Errands | BS | round trip, keep | 13:30–15:00 | 1A | −30/+60 / −30/+60 | |
| R6 | Levi | Other | TA | round trip, keep | 09:00–17:30 | 4A+2CS | 0 / 0 | luggage |
| R7 | Eitan | Work | BIN | **one_way_from, relay** | arrive 12:00 | 1A | — / ±30 | drives a car home from Binyamina |
| R8 | Rina | Healthcare | ASH | round trip, keep | 12:30–14:30 | 1A+1B | ±30 / ±30 | **late** |

**Relay pairing** (§3.6.1, before scoring): R3's out leg occupies `[09:00, 09:45)` (travel 45) and leaves the car at BIN; R7's back leg occupies `[11:15, 12:00)` and needs a car at BIN at 11:15. Same `destination_id`, `09:45 ≤ 11:15`, same day → pair **P = {R3, R7}**, idle 90 min, no shift. Both legs now count 2 people for `peopleServed`.

**Scores** (weight × normalized value; see §4.3; on-time submissions are treated as simultaneous so the rank term is 0):

| Id | rideType | distance | PT | people | fairness | submission | flex | total |
|---|---|---|---|---|---|---|---|---|
| R1 | 1.00 | 0.167 | 0.21 | 0 | 0.25 | 0.20 | 0 | **1.827** |
| R4 | 0.80 | 0.267 | 0.15 | 0.15 | 0.25 | 0.20 | 0 | **1.817** |
| R8 | 1.00 | 0.167 | 0.21 | 0.075 | 0.25 | 0 (late) | 0.10 | **1.802** |
| R7 | 0.80 | 0.233 | 0.06 | 0.075 (pair) | 0.35 | 0.20 | 0.05 | **1.768** |
| R6 | 0.50 | 0.367 | 0.09 | 0.30 | 0.25 | 0.20 | 0 | **1.707** |
| R3 | 0.80 | 0.233 | 0.06 | 0.075 (pair) | 0.25 | 0.20 | 0.05 | **1.668** |
| R2 | 0.80 | 0.367 | 0.09 | 0 | 0.10 | 0.20 | 0.10 | **1.657** |
| R5 | 0.30 | 0.267 | 0.15 | 0 | 0.45 | 0.20 | 0.15 | **1.517** |

Units in greedy order: R1, R4, R8, **P** (score of its stronger leg, R7 = 1.768), R6, R2, R5.

**Greedy pass**:

1. R1 (1,0,0) → **C1** 08:00–12:00 at preferred (all cars free and at H; C1's {4,0,0} has the tightest slack 3; the block ends 07:00, 07:00 + 30 ≤ 08:00).
2. R4 (2,1,0) → **C1** 13:00–15:30 (C1's {2,1,0} has slack 0; C1 is free again from 12:30 = 12:00 + buffer; C3 is blocked 13:00–17:00 anyway).
3. R8 (1,0,1) → **C2** 12:30–14:30 at preferred (C1 busy with R4; C3 blocked; C2 slack 3 via {4,0,1} beats C4 slack 5).
4. **P** (R3 out 09:00–09:45 H→BIN, R7 back 11:15–12:00 BIN→H): needs one car at H at 09:00 and nothing else on it until 12:00. C1 busy (R1). C2 free until 12:00 (R8 starts 12:30, and 12:00 + 30 ≤ 12:30) ✓. C3 free until 12:30 (block at 13:00) ✓. C4 free ✓ but slack 6. C2/C3 tie on slack 4 → continuity: Noa's usual car → **C3**. Blocks added: `[09:00, 09:45) H→BIN`, `[11:15, 12:00) BIN→H`; between them C3 is *away at BIN* (`carsAway`). Reason `PLACED_RELAY_PAIR`: "שובץ לקורולה: נועה נוהגת לבנימינה ב-09:00 ומשאירה את הרכב; איתן מחזיר אותו ב-12:00".
5. R6 (4,2,0) + luggage → **C4** 09:00–17:30 (only car whose configs dominate; free).
6. R2 08:30–17:00 needs 8.5 h inside 08:00–17:30: C1 (R1, R4), C2 (free only until 12:00), C3 (P, then block), C4 (R6) → **unmet (for now)**.
7. R5 13:30–15:00, flex −30/+60 both: C1 free from 16:00 (R4 15:30 + 30) but latest departure 14:30 ✗; C2 free from 15:00 (R8 14:30 + 30) ✗; C3 blocked 13:00–17:00 and free again only after 17:30 ✗; C4 ✗ → **unmet (for now)**.

**Improvement pass** (unmet by score: R2, then R5):

- R2: on C1 the blockers R1 and R4 have flex 0 — R1 could move to C2 at its exact time, but R4 fits nowhere else (C2 has R8, C3 is blocked, C4 has R6); on C2 the blocker R8 cannot leave (C1: R4 from 13:00; C3: block; C4: R6); on C3 the block is fixed (car skipped); on C4 R6 fits no other car. 6 evaluations, no solution.
- R5: blocker on C2 is R8 (12:30–14:30, flex ±30). Relocating R8 to C1 fails (R1 until 12:30, R4 from 13:00). Relocating R8 **within C2** to 12:00–14:00 (−30/−30, inside its flexibility) frees C2 from 14:30; R5 fits at 14:30–16:00 (departure +60, return +60, both within declared flexibility). Applied: R8 → C2 12:00–14:00 (its final shift is −30/−30, so its assignment is recomputed as `PLACED_SHIFTED`, "שובץ לC2 עם הזזה של 30 דק' ביציאה ו-30 דק' בחזרה, בתוך הגמישות שהוצהרה" — the Hebrew does not name R5 as the beneficiary), R5 → C2 14:30–16:00 (`PLACED_SHIFTED`).

**Resulting assignments**

| Car | Rides (car origin → destination) |
|---|---|
| C1 | R1 Dana 08:00–12:00 (H→H) · R4 Avi 13:00–15:30 (H→H) |
| C2 | R8 Rina 12:00–14:00 (H→H, shift −30/−30) · R5 Michal 14:30–16:00 (H→H, shift +60/+60) |
| C3 | R3 Noa 09:00–09:45 (**H→BIN**, relay out) · *away in Binyamina 09:45–11:15* · R7 Eitan 11:15–12:00 (**BIN→H**, relay back) · block 13:00–17:00 |
| C4 | R6 Levi 09:00–17:30 (H→H) |

Every car chains (`destinationId` of each ride = `originId` of the next) and ends the day at H; `carsAway = [{C3, BIN, 09:45–11:15}]`. Buffers: C3 12:00 + 30 ≤ 13:00 (block) ✓; C2 14:00 + 30 ≤ 14:30 ✓; C1 12:00 + 30 ≤ 13:00 ✓.

**Unmet: R2 Yossi** (`UNMET_NO_CAR`; blockers C1:R1/R4, C2:R8/R5, C3:R3/R7 + block, C4:R6). Suggestions, in order:

1. `merge` (leg `both`) into R6's ride on C4 — same destination, detour 0; host times 09:00/17:30 lie inside Yossi's flexibility (shift +30/+30 for him, none for Levi); seats (4,2,0) + (1,0,0) = (5,2,0) ≤ {5,2,0}; C4 has a large trunk. Proposed driver: **Levi** (host). `confidence = 1 − 0 − 0 − 60/480 = 0.875`. Reason: "הצטרפות לנסיעה של לוי לתל אביב, יציאה 09:00 וחזרה 17:30, ללא סטייה".
2. `shiftBeyondFlex` — none: with ±2 h (06:30–19:00) no car has an 8.5 h gap at H (omitted).
3. `externalHint: publicTransport` — Tel Aviv PT score 0.7 ≥ 0.6. `confidence 0.3`.
4. `deny` — "לא נמצא רכב פנוי; ניתן לדחות".

**Merge opportunities** (informational): none — R5 → R4 on C1 (same zone BS, times inside Michal's windows) fails the seat check: (2,1,0) + (1,0,0) = (3,1,0) is dominated by none of the Picanto's configurations.

Why Yossi is the one left out is visible in the breakdown: his low fairness deficit (0.2, many rides recently) costs him 0.15 relative to the default; with 0.5 he would score 1.807 and enter the greedy pass third, taking C2 at his preferred time. The Sadran can override with a manual boost and re-solve.

**Variant — no partner.** If R7 did not exist, R3 would be a lone relay out-leg: never placed (the car would end the day in Binyamina), `UNMET_NO_RELAY_PARTNER`. Its suggestions: `merge` — none (nobody else drives to BIN); `convertToRoundTrip` on C3 09:00–12:30 (latest return before the 13:00 block minus buffer; Noa keeps the Corolla and brings it back) → `shift` proposal; `chauffeur` on C2 or C3 09:00–10:45 (2 × 45 + 10 = 100 min, rounded up to 7 slots) — the request shows "דרוש/ה נהג/ת" until the Sadran assigns a volunteer; `externalHint: publicTransport` (PT 0.8); `deny`.

---

## 9. Assumptions introduced by this document

Collected for the product owner in `REQUIREMENTS.md` §13 items 14–24 and 57–65 (review them there). Owner answers of 2026-09-06 are marked.

1. ~~One-way requests block the car for `2 × travel_minutes`.~~ **Replaced** (owner, 2026-09-06) by the leg / car-mode model of REQUIREMENTS §5.4: `relay` occupies the travel time and moves the car, `chauffeur` occupies `2 × travel + dwell`, `passenger` has no own occupancy (§1.2).
2. The turnaround buffer (30 min) also applies between a ride and a maintenance block. (confirmed)
3. `matchFreedSlot` may use the candidate's declared flexibility; it never displaces a placed ride. Auto-approve of a newly submitted request is a SQL-only concern (`try_auto_approve`, §5.2) and does not use flexibility either — a human is not in the loop, so only the exact requested time is approved. (confirmed; TS reference implementation removed, 2026-09-11 — REFACTOR_PLAN_2026-09-11 D13, dead code with no caller)
4. ~~Merge detour is estimated from destination travel minutes/distance differences.~~ **Superseded 2026-10-05 (REQUIREMENTS §13.95):** merge detours are computed by cheapest insertion into the host's route with `travelBetween()` (stored route → home preset → default minutes); distance is checked only when every hop's km is known.
5. Fairness deficits and "usual car" are computed by the data layer and passed in; the solver defines only their range (0..1) and default (0.5); the lookback is the fairness rule's `lookbackWeeks` param (default 3). (confirmed)
6. Relay pairing matches on the exact `destination_id`; zone-level pairing would change `pairRelays()` only. (confirmed)
7. Relay pairing runs before scoring and ignores scores, so `peopleServed` can credit both legs of a pair without circularity (§3.5). (new in v0.3)
8. A lone relay leg is never placed *as* `relay` by the solver (day-end rule) — **superseded 2026-09-16 (REQUIREMENTS §13.88/§13.89):** it is placed anyway, as a standalone `chauffeur` ride (§3.6.1a); only when no car has room for that does the Sadran resolve it via `convertToRoundTrip`, `chauffeur`, a merge or a deny. One-way requests are never auto-approved after publish (REQUIREMENTS §13.64). (new in v0.3)
9. `convertToRoundTrip` proposes the latest feasible return time on that car (the requester keeps the car as long as the day allows), not the earliest. (new in v0.3)
10. **The day-end rule (item 9 of §1.3, this section's item 8) is retired** by REQUIREMENTS §13.93 (owner, 2026-10-04, `docs/ORIGINS_PLAN_2026-10.md`): a car legitimately stays wherever its last ride left it, across days and weeks; see §1.3a.
11. ~~`merge.ts`'s destination-to-destination detour heuristic.~~ Removed 2026-10-05 (§3.8, REQUIREMENTS §13.95): merges no longer use the zone/same-origin heuristic; different origins merge when the insertion fits the detour limit and the boarding precedes the host's final destination.
12. The `changeOrigin` suggestion (§1.3a, §3.11 item 4a) tries only the request's exact preferred window, first qualifying car/location pair in deterministic order — no flexibility search, matching the style of every other "simplification" item in this section.
13. A `drop_off` with a pickup is solved as two one-way legs (§1.3a, REQUIREMENTS §13.94); the DB/apply layer must accept one request served by two rides (one per leg) and a request that is both partly served and partly unmet.
14. Merge insertion counts the stop dwell (`stopMinutes`) for every inserted boarding/alighting stop, rounds added driving up to whole slots for the window, and reports `detourMinutes` as the larger per-leg detour (REQUIREMENTS §13.95). SQL apply/board drop/joinable rides must use the same rule (db-migrator/ui-dev).
15. The connected pair of a split drop-off-with-pickup (§1.3a) is preferred in `pairRelays` over cross pairing; if it fits no car both halves fall back to chauffeur rides (REQUIREMENTS §13.95).

### 9.1 Implementation deviations (first solver-dev pass, 2026-09-06)

Recorded per CLAUDE.md hard rule 2 (docs move with the code). None contradict REQUIREMENTS; all are conservative simplifications of this document's algorithm sections, chosen to keep the search bounded and the first implementation reviewable. Follow-ups are welcome as separate, tested changes.

10. **Module file names** follow the caller's explicit deliverable list rather than §3's module-layout table: `seatFit.ts` (not `seats.ts`), `slots.ts` (folds in `normalize.ts`'s responsibilities: `toSlot`, flexibility resolution, `NormalizedRequest`/`NormalizedLeg`), `greedy.ts` (not `assign.ts`), `flexibility.ts` (not `flex.ts`), `splitLegs.ts` (not `split.ts`), `suggestions.ts` (not `suggest.ts`), plus two new files not in the original table: `invariants.ts` (assertInvariants, factored out of `index.ts`) and `live.ts` (`matchFreedSlot`, factored out of `index.ts`; a TS `tryAutoApprove` also lived here until 2026-09-11, when it was deleted as dead code with no caller — auto-approve of newly submitted requests was, and remains, SQL-only, §5.2). Public behavior is unchanged; `index.ts` re-exports everything.
11. **Relay pairing scope (§3.6.1) is narrower than described**: `pairRelays()` only pairs one-way (`one_way_to`/`one_way_from`) `relay` requests. A `round_trip` with `needsCarAtDestination = false` is tried as a single `keep` unit in the main greedy pass first (not pre-split into independent out/return legs for cross-pairing before scoring); only when that fails does `splitLegs.ts` resolve its legs independently, including the relay+relay self-pair and, via the still-unpaired one-way relay pool, the relay+passenger / passenger+relay combinations. This still satisfies every §7.1 unit-test-matrix scenario for split legs but does not attempt the more general pre-scoring cross-pairing the prose describes.
12. **`bestPlacementWithinFlex` (§3.7) matches the literal clamp formula**, which for a `both` (keep) leg means dep′ and ret′ are clamped independently toward their own preferred value and a gap is rejected outright if duration then fails — so a `keep` leg's *own* flex search can only ever confirm the unshifted `[D,R)` fits somewhere (a different car, or the same car's untouched slot), never a genuinely shifted window. Real shifted placements for `keep` legs (the R8/R5 case in §8) come from the improvement pass's dedicated same-car compression (`improve.ts`'s `closeGapSameCar`), not from this function — documented and unit-tested in `flexibility.test.ts`/`improve.test.ts`.
13. **`improve.ts` relocates only single round-trip (`keep`) placed rides.** A placed relay pair is treated as an immovable blocker (its car is skipped for that unit) and an unmet relay pair is not retried by the improvement pass. Depth-2 relocation and the ejection fallback are depth-1/2-blocker only, per §3.10's stated bounds.
14. **`merge.ts` host-shift search only covers `both` (keep) hosts**; a fixed host, or a host whose own leg is `out`/`return` only, never shifts (matches §3.8's "keeping `h`'s car free... at the new window" for the common case; the one-way-host-shift generalization is future work).
15. **The `perf-300x15` fixture is generated in-test** (`__tests__/perf.test.ts`, seeded `mulberry32` PRNG in `__fixtures__/gen.ts`) rather than checked in as a static `perf-300x15.input.json`, to keep the fixture file human-reviewable; the 300×15 shape and the `< 2s` assertion match §6/§7.1 exactly.
16. **Golden fixtures implemented in this pass**: `basic-4x8` (§8 worked example, reproduced exactly including the unmet suggestion order), `fixed-rides-only`, `all-unmet`, and the generated `perf-300x15`. `dst-spring`, `merge-detour-edge`, `split-legs`, `relay-unpaired`, `chauffeur`, and `needs-car-false-relay-passenger` are covered by the corresponding unit tests (`slots.test.ts`'s DST case, `merge.test.ts`'s detour-boundary case, `splitLegs.test.ts`) rather than by dedicated JSON fixture pairs; adding the remaining JSON pairs is future work, not a behavioral gap.
17. **An unpaired relay candidate's chauffeur placement (§3.6.1a, REQUIREMENTS §13.88/§13.89, rule made precise 2026-09-16) tries only the leg's own preferred window**, on the first shared car (by id) that fits the whole chauffeur window (and `chauffeurLoad`) — no flexibility search for the healing placement itself, unlike the ordinary greedy pass's `bestPlacementWithinFlex` fallback. A car with no room is skipped outright rather than retried with a shifted leg; a leg no car can take this way keeps the pre-existing `UNMET_NO_RELAY_PARTNER` path. Covered by `__tests__/canDrive.test.ts`, not a dedicated `relay-heal` JSON fixture pair (none of the existing golden fixtures contain a genuinely-unpaired relay leg, so none of their expected outputs changed by this 2026-09-16 redesign either — it replaces the previous `healLoneRelayLegs`/`PLACED_RELAY_SOLO` relocation-pair design in place, same file, same exported shape `{ healed, healedIds }`, new function name `chauffeurUnpairedRelayLegs`).
18. **Superseded 2026-10-04 (owner follow-up, same day):** the chauffeur-ride origin generalization (§1.3a) now implements ORIGINS_PLAN §3's full rule — both ends of an `out` leg are tried (drop-off at `A`, pickup at `B`, `chauffeurCandidates()`), matching the SQL side exactly for this one-way case; no outstanding gap for O3 here. (A `return` leg still keeps the legacy single formula, anchored at the request's own origin — unaffected by this item.)
19. **A free-text destination is never a place the car can be left at (2026-10-05).** A request to a free-text destination has `Request.destinationIsFreeText`; `tryPair` never pairs such legs and the bridge sends a `one_way` to a free-text destination as `drop_off` (served by a chauffeur ride or a passenger seat, never leaving the car at an unmatched place) — free-text places are never matched (REQUIREMENTS §13.93, §13.58). `buildApplyPayload` maps the pseudo id `__free_text__` to the ride's other end so `apply_solver_result` gets a real place. Covered in `__tests__/relay.test.ts` and `src/features/sadran/applySolve.test.ts`.
## Publication comparisons — 2026-09-07 TODO

Publication scores the **final board against every policy profile**, including inactive department/global profiles, without applying another solve. `gatherSolverContext({ forScoring: true })` includes all non-draft/non-withdrawn/non-cancelled requests, including fixed, denied and externally resolved requests. The existing pure normalization, relay pairing and policy engine calculate each request's score from original request data and that policy's own fairness lookback.

Actual `ride_requests` links determine served status. Each policy comparison stores total requested priority, served priority and `served / total` weighted coverage (null if total priority is zero), plus member/request rule breakdowns. Scores are not comparable as absolute values across differently weighted profiles; weighted coverage describes how much of each profile's requested priority the actual board serves. The persisted policy version makes later comparisons reproducible. Optimistic database fingerprints reject edits made while scoring. Manual drag flexibility stays anchored to original departure/return times.

Driverless pinned reservations become `FixedRide` constraints with no served request and no driver. They occupy the car timeline in both remaining/full solve modes, and cannot be suggested as a chauffeur or merge host.


### Existing tight bookings and missing drivers

`FixedRide.approvedBufferAfterSlots` carries the persisted coordinator-approved turnaround after a booking. Timeline loading and final invariant checks allow that reduced gap only between two fixed bookings; actual overlap and maintenance checks remain enforced. New solver placements keep the normal configured buffer. Missing-driver bookings remain pinned occupancy with their passenger request IDs, preventing a full resolve from silently deleting or duplicating them. Publication priority coverage counts those requests as unserved until a driver claims the booking.

**Reversed one-way merge (REQ item 109 g, R6B5).** `findMergeHosts` lets a `one_way_to` guest whose origin is the final place of a `both`-leg host's out route and whose destination is the final place of its return route (TA -> home into a home -> TA -> home ride) ride the host's **return** leg in its own direction (`MergeCandidate.reversedOneWay`; the guest's request leg stays `out`). It is timed by its boarding on the return leg against its own departure window (`Insertion.boardTailMinutes`); any other one-way that boards where the out leg ends is still refused. SQL twin `_merge_guest_swapped` / `_ride_route_with`; TS twin `isReversedOneWay` in `src/lib/rideRoute.ts`.
