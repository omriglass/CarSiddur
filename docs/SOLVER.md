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
- **Request** `r`: requester `m(r)`, destination `dest(r)` (with `zone`, `distance_km`, `travel_minutes`, `public_transport_score`, or zone `unknown` for free text), ride type, trip shape, legs, passengers `p(r) = (adults, childSeats, boosters)`, `luggage ∈ {0,1}`, `needsCarAtDestination`, `oneWayCarMode`, flexibility intervals, submission time, late flag, optional manual boost.
  - **Legs.** `tripShape ∈ {round_trip, one_way_to, one_way_from}`. A round trip has an **out** leg (leave `H` at departure `D`, travel `H → dest`) and a **return** leg (arrive `H` at return `R`, travel `dest → H`). `one_way_to` has only the out leg, `one_way_from` only the return leg.
  - **Car mode of a leg** `mode(leg) ∈ {keep, relay, passenger, chauffeur}` (REQUIREMENTS §5.4). Round trips with `needsCarAtDestination = true` are one fused `keep` block. For one-way shapes the member states `oneWayCarMode ∈ {relay, passenger}`; `chauffeur` is only ever a suggestion. For round trips with `needsCarAtDestination = false` each leg is resolved independently to `passenger` or `relay`, with `keep` as the fallback.
  - **Flexibility.** Independent intervals `FD(r) = [D − a, D + b]` and `FR(r) = [R − c, R + d]` (each side one of 0/15/30/60/120 min or "any time that day", which the caller resolves to the day's slot bounds).
- **Car** `c`: `type ∈ {shared, temporary}`, seat configurations `Q(c) = {(A, C, B)…}`, features (e.g. `large_trunk`), maintenance blocks (slot intervals), `luggageCapacity` (default 1; 2 with `large_trunk`), and a **location timeline**: the car starts the week at `H`; every ride moves it from its `originId` to its `destinationId`; between rides it sits where the last ride left it.
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
| `out`, `chauffeur` (drop-off) | `[D, D + 2·travel + dwell)` | `H → H` |
| `return`, `chauffeur` (pick-up) | `[R − 2·travel − dwell, R)` | `H → H` |
| any leg, `passenger` | none of its own — a seat in a host ride whose leg goes the same way (§3.8) | host's |
| Round trip, `needsCarAtDestination = false` | Either `[D, R)` as `keep` (fallback), **or** each leg as `passenger`/`relay` (§3.9); two `relay` legs on the same car leave it parked at `dest` in between, *free for others there*. | per leg |

Every window is rounded outward to the grid and has `minDurationSlots = max(1, ceil(occupancy / 15))`. A one-way request without a round trip is `durationFixed` (one shift dimension).

### 1.3 Hard constraints

1. **No overlap.** For rides `x ≠ y` on the same car: `s_y ≥ e_x + buffer` or `s_x ≥ e_y + buffer`. The same rule applies between a ride and a maintenance block. `buffer = config.bufferMinutes` (30, REQUIREMENTS §13.10).
2. **Seat fit** (§3.3): `Σ p(r)` over the ride's requests (plus one adult for a chauffeur volunteer) is dominated by some configuration of the car. Each request's `adults` includes its own would-be driver; when a request rides along as a passenger, *all* of its adults/childSeats/boosters join the host's load (its former driver is now a passenger) and the host's driver is counted exactly once, inside the host request's own `adults`. Nothing is ever subtracted.
3. **Luggage**: number of luggage requests in a ride `≤ luggageCapacity(c)`.
4. **Temporary cars** are never assigned by the solver; they only appear as merge hosts for their owner's rides. They never relay or chauffeur (`origin = destination = H` always).
5. **Fixed rides** are never moved.
6. Placements stay inside the request's declared flexibility, except `shiftBeyondFlex` *suggestions* (≤ 2 h, consent required).
7. Merges require detour `≤ config.detour` (20 min / 15 km) and are never applied by the solver — they are suggestions (REQUIREMENTS §13.4).
8. **Location.** A ride may start on a car only if the car's location at `s` equals the ride's `originId` (§3.2). Consequently the rides of a car chain: `destinationId(x_n) = originId(x_{n+1})`.
9. **Day end.** Every shared car is at `H` at the department's day end (`DayBounds.dayEndSlot`, default 23:59) — the solver never places a relay out-leg without a relay back-leg to `H` on the same car and day. Fixed rides may violate this only when the caller marks them `overnightAck` (Sadran acknowledged); the solver then treats the car as starting the next day where it was left.
10. **Chauffeur** rides need a driver who is not the requester; the solver never invents one — a chauffeur is a suggestion (§3.11 item 5) that the Sadran turns into a pinned ride with a volunteer as driver.

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

export interface Destination {
  id: string; zone: string;                 // 'unknown' for unclassified free text; 'home' for the department base
  distanceKm?: number; travelMinutes?: number;
  publicTransportScore?: number;            // 0..1, 1 = excellent service
}

export interface Flexibility { earlierMin: number | 'day'; laterMin: number | 'day' }

export interface Request {
  id: string; memberId: string; departmentId: string;
  destinationId: string; rideType: string;
  tripShape: TripShape;
  oneWayCarMode?: 'relay' | 'passenger';    // required when tripShape ≠ 'round_trip'
  departureMs?: number; returnMs?: number;  // epoch ms, 15-min aligned; departure absent for one_way_from, return absent for one_way_to
  flexDeparture: Flexibility; flexReturn: Flexibility;
  passengers: Passengers; coRiderMemberIds: string[];
  luggage: boolean; needsCarAtDestination: boolean;   // round trips only
  submittedAtMs: number; isLate: boolean;
  manualBoost?: { value: number; reason: string };   // value 0..1
  preferredCarId?: string;                  // carried over from a previous draft
}

export interface Car {
  id: string; name: string; type: 'shared' | 'temporary'; ownerMemberId?: string;
  seatConfigs: Passengers[]; features: string[]; luggageCapacity: number;
  maintenance: Window[];
  startLocationId?: string;                 // where the car is at week start; default = home
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
  bufferMinutes: number;            // default 30 (department_settings.turnaround_minutes)
  detour: { maxMinutes: number; maxKm: number };      // default 20 / 15
  beyondFlexMaxMinutes: number;     // default 120
  defaultTravelMinutes: number;     // default 60, used when the destination has no travel_minutes
  chauffeurDwellMinutes: number;    // default 10 (department_settings.chauffeur_dwell_minutes)
  improvementBudget: number;        // max relocation evaluations, default 5000
  perRequestBudget: number;         // default 200
  externalHints: { cabMaxMinutes: number; rentalMinHours: number; ptMinScore: number };
}

export interface SolverInput {
  week: { startMs: number; days: DayBounds[] };
  homeLocationId: string;                   // departments.home_destination_id
  cars: Car[]; requests: Request[]; fixedRides: FixedRide[];
  destinations: Record<string, Destination>;
  policy: Policy; stats: SolverStats; config: SolverConfig;
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
  driverRequestId?: string;                 // undefined for chauffeur rides
  driverMemberId?: string;                  // set by the Sadran for chauffeur rides; the solver leaves it undefined
  legs: AssignmentLeg[]; servedRequestIds: string[];
  passengers: Passengers; luggageCount: number;
  shift: { departureMin: number; returnMin: number };   // signed, 0 if at preferred
  pairedRideId?: string;                    // the other leg of a relay pair (§3.6.1)
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
       detourMinutes: number; detourKm: number })
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
  index.ts        solve(), matchFreedSlot(), tryAutoApprove()
  types.ts        normalize.ts   seats.ts   timeline.ts (location-aware)
  policy/engine.ts   rules/index.ts   rules/<type>.ts
  assign.ts  relay.ts  flex.ts  merge.ts  split.ts  improve.ts  suggest.ts
  reasons.ts      Hebrew templates keyed by reasonCode
  __fixtures__/   __tests__/
```

### 3.1 Normalization (`normalize.ts`)

- `toSlot(ms) = floor((ms − week.startMs) / 900_000)`. Departure floors, return ceils; misalignment emits a warning `TIME_NOT_ALIGNED`.
- `'day'` flexibility resolves to `days[dayIndex(D)].startSlot … endSlot`. Because DST days are handled by the caller's `DayBounds`, the solver's arithmetic is uniform.
- **Legs.** From `tripShape`/`needsCarAtDestination`/`oneWayCarMode` build `NormalizedLeg { side: 'out'|'return'|'both', preferredMode: LegCarMode, originId, destinationId, window, flex: [lo, hi] }` per §1.2 (`round_trip` + needs car → one `both` leg `keep`; `round_trip` without → `both` leg `keep` as fallback plus `out`/`return` legs eligible for `passenger`/`relay`; `one_way_to` → `out` leg in the stated mode; `one_way_from` → `return` leg).
- Build `NormalizedRequest { legs, window, minDurationSlots, flexDep: [lo, hi], flexRet: [lo, hi], durationFixed: boolean, travelSlots }`. For one-way shapes `durationFixed = true` (only one shift dimension). `travelSlots = ceil((dest.travelMinutes ?? config.defaultTravelMinutes) / 15)`.
- Requests served by a `FixedRide` are marked `servedByFixed` and skipped; their fixed rides become `Assignment { source: 'fixed' }` and seed the timelines with their origin/destination.
- Validation warnings, never throws: return before departure, outside week, passenger set fits no active car (`NO_CAR_FITS_SEATS`), one-way shape without `oneWayCarMode` (`ONE_WAY_MODE_MISSING`, treated as `passenger`), a fixed ride whose origin does not match the car's location at its start (`FIXED_RIDE_LOCATION_MISMATCH` — reported, the fixed ride is still honoured), a fixed ride leaving a car away at day end without `overnightAck` (`CAR_AWAY_AT_DAY_END`).

### 3.2 Car timelines (`timeline.ts`)

```ts
export interface Block { rideId: string; window: Window; startLocationId: string; endLocationId: string }
export interface Gap { window: Window; locationId: string }        // where the car sits during the gap

export class CarTimeline {
  constructor(car: Car, bufferSlots: number, weekSlots: number, homeLocationId: string);
  isFree(w: Window, originId: string): boolean;      // O(log n): free AND the car is at originId when w starts
  locationAt(slot: Slot): string;                    // O(log n)
  gaps(): Gap[];                                     // free intervals with the car's location, O(n)
  add(b: Block): void;                               // O(n) insert into sorted array; rejects a block whose startLocationId ≠ locationAt(start)
  remove(rideId: string): void;
  awayAt(slot: Slot): boolean;                       // locationAt(slot) ≠ home
  awayWindows(): { locationId: string; window: Window }[];   // for SolverOutput.carsAway and the day-end check
}
```

Every occupancy (ride, maintenance block, fixed ride) is stored as `[start, end + buffer)` with its start/end location; maintenance blocks do not move the car (`start = end = locationAt(start)`). A candidate `[s, e)` with origin `o` is legal iff `[s, e + buffer)` is disjoint from all stored intervals **and** `locationAt(s) = o` — this yields exactly the symmetric rule of §1.3.1 plus the location rule of §1.3.8 with one binary search. The car's location between blocks is the `endLocationId` of the preceding block (or `car.startLocationId ?? home` before the first). Per car there are at most a few dozen intervals, so a sorted array beats a tree. The day-end rule (§1.3.9) is a query over `awayWindows()`: no away window may contain a day's `dayEndSlot` unless the block that moved the car there is a fixed ride with `overnightAck`.

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
2. `slack(car, passengers)` — tightest seat fit, keeps large cars for large groups (for a pair: the max over the two legs)
3. continuity: `0` if `car.id === previousAssignment(r).carId`, else `1` if `car.id === stats.usualCarId[member]`, else `2` (for a pair: the min over both members)
4. fragmentation: leftover of the gap the ride lands in (`gap.length − ride.length`, best-fit) — avoids splitting a long free window (for a pair: the gap is `[out.start, back.end)`)
5. `car.id`

#### 3.6.1 Relay pairing (`relay.ts`)

```ts
export function pairRelays(requests: NormalizedRequest[], ctx): { pairs: RelayPair[]; unpaired: NormalizedRequest[] }
export interface RelayPair { outRequestId: string; returnRequestId: string; destinationId: string; idleSlots: number; shift: {...} }
```

Input: every request with a `relay` leg — `out` legs (`one_way_to` + `relay`, and the out leg of a `needsCarAtDestination = false` round trip) and `return` legs (`one_way_from` + `relay`, and the return leg of such a round trip). Rule (REQUIREMENTS §5.4, §13.58): `o` and `b` pair iff

- same `destinationId` (exact; zone-level pairing is v1.x),
- `o.window.end ≤ b.window.start` after choosing the minimal shift of each inside its own declared flexibility (`b.start` may be pushed later, `o.start` earlier — never beyond flex),
- both on the same local day (the car must be home by `dayEndSlot`),
- each leg's own passengers fit some shared car — the pair is later placed on one car, so `fits` is checked per leg against the car (§3.3).

Greedy matching: candidate pairs sorted by `(idleSlots + shiftCost, outId, returnId)` — no scores, because pairing runs before scoring (§3.5); each request joins at most one pair. `idleSlots = b.start − o.end` is the time the car sits at the destination. A request whose round trip was split into two relay legs pairs **with itself** (car parked at the destination in between, free for third parties there) — this is the `relay+relay` resolution of §3.9 and is tried only when the fused `keep` block does not fit. Unpaired relay requests stay single units: a lone `relay` out-leg or back-leg can never be placed (the car would end the day away, §1.3.9) and goes straight to `unmet` with the suggestions of §3.11 item 5. Pairs whose match needs a shift beyond declared flexibility (≤ 2 h) are not formed but remembered, and surface as `shiftBeyondFlex` suggestions with `pairsWithRequestId` on the leg that would have to move.

### 3.7 Flexibility search (`flex.ts`)

```ts
export function bestPlacementWithinFlex(tl: CarTimeline, u: Unit): Placement | null
```

For each free gap `[g1, g2)` of the car **whose location equals the leg's origin**, the feasible region is `dep' ∈ [max(flexDep.lo, g1), flexDep.hi]`, `ret' ∈ [flexRet.lo, min(flexRet.hi, g2 − buffer)]`, with `ret' − dep' ≥ minDurationSlots`. The minimal-shift point is `dep' = clamp(D, …)`, `ret' = clamp(R, …)` — O(1) per gap, no enumeration of the 96×96 shift pairs. If the duration constraint fails after clamping, the region is empty for that gap (both bounds are already the closest to the preferred). Across gaps and cars, order by `shiftCost`, then earlier departure, then the car key. For `durationFixed` legs the same computation runs in one dimension. For a relay pair the out-leg is placed first in a home gap, then the back-leg in the resulting away gap (`[out.end, next block)`), minimizing the summed shift. Beyond-flex search (§3.11) is the same function with the intervals widened by `beyondFlexMaxMinutes`.

### 3.8 Merge candidate detection (`merge.ts`)

```ts
export function findMergeHosts(guest: NormalizedRequest, leg: LegSide, rides: Assignment[], ctx): MergeCandidate[]
```

Merging is **per leg**: a `both` guest needs a host whose ride covers both directions (a `keep` ride); an `out` guest (one-way `passenger`, or the out leg of a split round trip) needs a host ride whose out leg goes there — a `keep` ride's outbound, a relay out-leg ride, or a chauffeur drop-off; a `return` guest needs a host coming back from there. A ride `h` (solver or fixed, including temporary-car owner rides) hosts guest `g` on leg `L` iff:

- **Destination compatibility:** same `destinationId`, or same `zone`, or `detour(h.dest, g.dest) ≤ config.detour`, where `detour` is estimated as `|travelMinutes_h − travelMinutes_g| + zonePenalty` and `|distanceKm_h − distanceKm_g|`; zone `unknown` never merges.
- **Time compatibility:** `h.departure ∈ FD(g)` for an out leg, `h.return ∈ FR(g)` for a return leg, both for `both`. If not, and `h` is not fixed, try shifting `h` within its own flexibility to the nearest point that satisfies the condition (`hostShift`), keeping `h`'s car free (and at the right location) at the new window.
- **Seats:** `fits(car_h, sum(h.passengers on leg L, g.passengers))` — per leg, §3.3.
- **Luggage:** `h.luggageCount + g.luggage ≤ luggageCapacity(car_h)`.

`cost = detourMinutes + shiftCost(g) + shiftCost(h)`; `confidence = 1 − 0.4·detour/maxDetour − 0.1·(guests already in h) − shiftCost(g)/480`. The proposed driver is the host's driver unless the host request has `needsCarAtDestination = false` and the guest has `true`, in which case the guest is proposed as driver (REQUIREMENTS §13.9 allows the Sadran to set another driver). The guest's leg is recorded with `carMode = 'passenger'`.

Merges are never applied automatically. Two lists are produced: merges for unmet requests (as `Suggestion`) and `mergeOpportunities` between two *assigned* rides, ranked by freed car-slots, for the Sadran's information.

### 3.9 Split legs (`split.ts`)

For an unmet round trip with `needsCarAtDestination = false`: each leg is resolved independently to `passenger` (a host per §3.8) or `relay` (a car free at the leg's origin for `travel` slots, which — for the out leg — leaves the car at the destination and therefore needs a relay back-leg the same day: the requester's own return leg as `relay`, or another member's paired back-leg). Combinations tried, in order: passenger/passenger (two hosts `X`, `Y`; `X = Y` is a plain merge and is reported as such), relay/passenger (the requester drives out and leaves the car — only if another relay back-leg from that destination pairs with it, §3.6.1), passenger/relay (the requester drives home a car that a relay out-leg left there), relay/relay (self-pair, car parked at the destination in between). Passenger fit is checked per leg, so a family that rides out with X can still fit even if X picks up others on the way back. `cost = shiftCost + detour_X + detour_Y (+ idleSlots for relay legs)`, `confidence = 0.6 · min(conf_X, conf_Y)` for two consents; relay legs need no consent beyond the declared flexibility and count `conf = 1`. The result is one `splitLegs` suggestion whose two entries carry `carMode` (`passenger` → `merge` proposal leg, `relay` → applied directly by the board).

### 3.10 Bounded local improvement (`improve.ts`)

Goal: serve an unmet unit by **relocating** already-placed solver rides within their declared flexibility (consent-free per REQUIREMENTS §13.3). Fixed rides never move. A relay pair relocates as one unit (both legs move to the same target car); relocations keep every car's location chain valid (`tl.add` rejects a block whose origin does not match).

```
budget = config.improvementBudget
for u in unmet sorted by score desc:
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

The search is depth ≤ 2, at most 2 blockers, and hard-capped by two counters; `stats.budgetExhausted` reports when a cap was hit. Relocations are recorded on the moved assignment (`reasonCode: RELOCATED_FOR`, Hebrew reason names the beneficiary). **Displacement** — ejecting a lower-priority placed ride to serve a higher-priority one — is never done automatically (REQUIREMENTS §7.1, §13.19); the greedy order already serves higher scores first, and when the improvement pass finds a solution only by ejecting, it emits it as a `shiftWithinFlex` suggestion with non-empty `relocations` (the ejected ride listed with `toCarId = ''`) for the Sadran to decide **before publish**. After publish `solve()` is never run automatically and the live helpers (§5.2) never relocate or eject anything.

### 3.11 Suggestion generation (`suggest.ts`)

For each remaining unmet request, in REQUIREMENTS §7.1 order:

1. `shiftWithinFlex` — only reachable via relocations the improvement pass declined to apply; otherwise absent.
2. `merge` — from §3.8, per leg, up to 3 hosts. For a one-way `passenger` leg this is the primary suggestion.
3. `shiftBeyondFlex` — `bestPlacementWithinFlex` with intervals widened by ≤ 2 h; `confidence = 0.5 − shiftCost/480`. For a relay leg that would pair if one side moved beyond its flexibility, the suggestion carries `pairsWithRequestId` (§3.6.1).
4. `splitLegs` — §3.9, only for round trips with `needsCarAtDestination = false`.
5. One-way legs without a host or a partner (REQUIREMENTS §7.1 item 5), in this order:
   - `convertToRoundTrip` — for an unpaired `relay` **out** leg: a shared car is free from `H` for `[D, ret)` where `ret` is the **latest** slot before the car's next occupancy that day (minus buffer, capped at `dayEndSlot`) and at least `D + 2·travel`; the requester would keep the car and bring it back by then (consent; `confidence = 0.4`).
   - `chauffeur` — for any one-way leg (`passenger` without host, `relay` without partner): a shared car is free at `H` for the §1.2 chauffeur window; the request is shown as **needs a driver** (`stats.needsDriver`), the Sadran assigns a volunteer; `confidence = 0.5`. `volunteerCandidateMemberIds` lists members already driving that day with no overlapping ride, sorted by id.
6. `externalHint` — `cab` if single leg or occupancy ≤ `cabMaxMinutes` (90) and `distanceKm ≤ 30`; `rental` if occupancy ≥ `rentalMinHours` (30, spans days); `publicTransport` if `public_transport_score ≥ ptMinScore` (0.6).
7. `deny` — always present, last, with the blockers listed in the reason.

### 3.12 Post-conditions

Before returning, `assertInvariants(output)` checks no-overlap per car (including buffer and maintenance), seat fit for every ride (per leg, +1 adult for chauffeur rides), every request appears exactly once (assignment, unmet, or servedByFixed), fixed rides unchanged, **location chain per car** (`destinationId` of ride *n* = `originId` of ride *n+1*, first ride starts at `car.startLocationId ?? home`), **every shared car home at every `dayEndSlot`** unless a fixed ride with `overnightAck` left it away, temporary cars only `H → H`, and every relay out-leg paired with a back-leg on the same car. A violation throws `SolverInvariantError` — the caller shows an error and keeps the previous draft.

### 3.13 Explainability

Every assignment, unmet record and suggestion has a `reasonCode` and a Hebrew `reason` rendered by `reasons.ts` from a template plus params (car name, times, member names supplied via `input`). `reasons.ts` is the **only** file under `src/solver` that contains Hebrew (CLAUDE.md hard rule 3): it also holds the rule descriptions shown in the admin UI (`RULE_<TYPE>_DESC`) and the `PolicyParamsError` messages, keyed by code. Examples:

| Code | Hebrew template |
|---|---|
| `PLACED_PREFERRED` | `שובץ ל{car} בזמן המבוקש` |
| `PLACED_SHIFTED` | `שובץ ל{car} עם הזזה של {dep} ביציאה ו-{ret} בחזרה, בתוך הגמישות שהוצהרה` |
| `RELOCATED_FOR` | `הועבר ל{car} כדי לפנות מקום לבקשה של {member}` |
| `PLACED_RELAY_PAIR` | `שובץ ל{car}: {member} נוהג/ת ל{dest} ב-{dep} ומשאיר/ה את הרכב; {partner} מחזיר/ה אותו ב-{ret}` |
| `UNMET_NO_CAR` | `אין רכב פנוי בחלון המבוקש; חוסמים: {blockers}` |
| `UNMET_NO_RELAY_PARTNER` | `אין מי שיחזיר/יביא את הרכב מ{dest} באותו יום; הרכב חייב לחזור הביתה עד {dayEnd}` |
| `UNMET_NEEDS_DRIVER` | `אין נסיעה מתאימה להצטרף אליה; דרוש/ה נהג/ת מתנדב/ת להסעה ל{dest} ב-{dep}` |
| `UNMET_CAR_AWAY` | `{car} נמצא/ת ב{location} בשעות האלה ולא זמין/ה מהבית` |
| `SUGGEST_MERGE` | `הצטרפות לנסיעה של {host} ל{dest} ביציאה {dep} ובחזרה {ret}, ללא סטייה` |
| `SUGGEST_MERGE_LEG` | `הצטרפות כנוסע/ת לנסיעה של {host} {direction} {dest} ב-{time}` |
| `SUGGEST_BEYOND_FLEX` | `הזזה של {dep} מעבר לגמישות שהוצהרה — דורש הסכמה` |
| `SUGGEST_ROUND_TRIP` | `במקום להשאיר את הרכב ב{dest}: לקחת אותו הלוך ושוב ולחזור ב-{ret} — דורש הסכמה` |
| `SUGGEST_CHAUFFEUR` | `הסעה: נהג/ת מתנדב/ת מסיע/ה ל{dest} ב-{dep} וחוזר/ת עם הרכב (כ-{minutes} דק'); הסדרן/ית משבץ/ת נהג/ת` |
| `SUGGEST_DENY` | `לא נמצא פתרון; ניתן לדחות עם הסבר` |

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
| `deny` | `deny` | requester acknowledges | `{reason}` with the blockers |

`shiftWithinFlex` never produces a proposal because the member already consented (REQUIREMENTS §7.1 item 1); `chauffeur` never produces a proposal to the requester because nothing changes for them except who drives; everything else needs an answer via `/p/<token>` or a Sadran-recorded answer.

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

### 4.2 Scoring

```ts
export function scoreRequests(input: SolverInput, batch: NormalizedRequest[]): Map<string, ScoreBreakdown>
// total(r) = Σ_i weight_i · norm_i(score_i(ctx_i, r))
```

Normalization runs per rule over the whole batch before weighting: `unit` clamps to `[0,1]`; `minmax` maps the batch min/max to `0..1` (all-equal → `0`). Weights may be negative. Unknown rule types in a policy produce a warning `UNKNOWN_RULE_TYPE` and are skipped, never a crash — the policy is data and may be newer than the code. `ScoreBreakdown` (per rule value, weight, contribution) is returned to the UI for the "why this order" panel.

### 4.3 Shipped rule types

| type | params | raw value |
|---|---|---|
| `rideType` | `{ weights: Record<string, number> }` | `weights[type] / max(weights)`; unknown type → 0 |
| `distance` | `{ maxKm: number }` | `min(distanceKm / maxKm, 1)`; unknown → 0 |
| `publicTransport` | `{}` | `1 − publicTransportScore`; unknown → 0.5 |
| `peopleServed` | `{ cap: number }` | `min((adults + childSeats + boosters − 1) / cap, 1)`; for a request in a relay pair (§3.6.1) the people of both legs are summed, so a pair outranks a lone request of the same type |
| `fairness` | `{ lookbackWeeks: number }` | `stats.fairness[member].deficit` (0..1, computed by the caller for the lookback; missing → 0.5). `lookbackWeeks` default **3** (REQUIREMENTS §13.18); the caller passes it to `fairness_stats()` |
| `submissionTime` | `{ latePenalty: number }` | on time: `1 − 0.3 · rank/N` by `submittedAtMs`; late: `max(0, 0.7 − latePenalty)` |
| `flexibilityOffered` | `{ fullCreditMinutes: number }` | `min(totalDeclaredFlexMinutes / fullCreditMinutes, 1)`; `'day'` counts as 480 |
| `manualBoost` | `{}` | `request.manualBoost?.value ?? 0` |

"Late penalty" is thus part of `submissionTime` (a policy param, not a department setting); "manual boost" is an ordinary rule whose value comes from the request, so a Sadran boost only has effect if the policy includes the rule with a weight (default 2.0). `rideType.weights` is keyed by `ride_types.code` (`work`, `childcare`, `healthcare`, `errands`, `other`); `fairness.lookbackWeeks` is likewise policy data — default **3 weeks, per member**, no department setting (REQUIREMENTS §13.18; the caller reads it from the active policy and calls `fairness_stats(dept, week, lookbackWeeks)`, DATA_MODEL §7.3). This JSON is what `supabase/seed.sql` inserts as `policy_versions` v1 of the global default.

### 4.4 Example policy

```json
{ "id": "nevo-default", "version": 3, "rules": [
  { "type": "rideType", "weight": 1.0, "params": { "weights": { "healthcare": 10, "work": 8, "childcare": 8, "other": 5, "errands": 3 } } },
  { "type": "distance", "weight": 0.4, "params": { "maxKm": 60 } },
  { "type": "publicTransport", "weight": 0.3, "params": {} },
  { "type": "peopleServed", "weight": 0.3, "params": { "cap": 4 } },
  { "type": "fairness", "weight": 0.5, "params": { "lookbackWeeks": 3 } },
  { "type": "submissionTime", "weight": 0.2, "params": { "latePenalty": 1 } },
  { "type": "flexibilityOffered", "weight": 0.2, "params": { "fullCreditMinutes": 240 } },
  { "type": "manualBoost", "weight": 2.0, "params": {} }
] }
```

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

`fixedRides` (pinned, applied proposals, temporary-car owner rides) are copied to the output as `source: 'fixed'` and seeded into timelines; the requests they serve are excluded. The solver is stateless about request status — the caller decides which requests are open (`submitted`, `waitlisted`, `denied` if the Sadran wishes, `proposed` if it wants the fallback computed). "Auto-solve remaining" on the board is the caller passing every current draft ride as a `FixedRide { kind: 'pinned' }` (REQUIREMENTS §7.1: manual edits become pinned). A full re-run passes only real pins and supplies the previous draft as `previousAssignments` so continuity (§3.6 key 3) minimizes churn. Output never contains changes to fixed rides.

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
export function matchFreedSlot(input: FreedSlotInput): FreedSlotCandidate[];
```

A candidate qualifies if it is a **round trip** (`keep`), its flexible envelope intersects `freedWindow`, its passengers fit the car, luggage fits, and `bestPlacementWithinFlex(timeline, r)` finds a window whose gap location is `home` (the freed window may merge with adjacent free time — the timeline, not the freed window alone, decides). One-way requests are never freed-slot candidates (they need a partner, a host or a driver — REQUIREMENTS §13.64). Results are ordered by `(−score, shiftCost, id)`. The caller applies §8: one candidate → auto-assign and notify; several → push all and the Sadran; none → slot stays free. **Relay legs**: cancelling one leg of a pair does not create an offer at all — `cancel_ride` flags the partner leg for the Sadran (REQUIREMENTS §13.63); only when both legs are cancelled is the whole window at home freed and offered.

```ts
export interface AutoApproveInput {
  request: Request; cars: Car[]; timelines: Record<string, CarTimeline>;   // all rides incl. published, location-aware
  config: SolverConfig; stats: SolverStats; week: SolverInput['week']; homeLocationId: string;
}
export function tryAutoApprove(input: AutoApproveInput): Assignment | null;
```

`tryAutoApprove` places a **round-trip** request **only at its preferred time** (no shift, no relocation, no merge; REQUIREMENTS §13.16) on a shared car that is free *and at home* for the window (`isFree(w, home)`), chosen by the §3.6 key; `null` means `waitlisted`. One-way requests always return `null` (§13.64). The **authoritative** auto-approve runs in SQL: `submit_request()` calls `try_auto_approve()` inside the transaction; the exclusion constraint and `assert_car_chain()` are the final arbiters (`ARCHITECTURE.md` §6.4, `DATA_MODEL.md` §5, §6 step 16). This TS function is the reference implementation that the SQL mirrors (shared fixtures) and powers the request form's "will be approved immediately" preview. Likewise `matchFreedSlot` is called by the `on-ride-cancelled` edge function over candidates pre-filtered by the SQL `freed_slot_candidates()`; the outcome is written by `resolve_freed_offer()`. Edits of an assigned ride use `timeline.isFree(newWindow, ride.originId)` on the same car (with the old ride removed); otherwise the caller treats it as cancel + new request. "Car goes to maintenance": the caller re-runs `solve()` with only the affected requests open and everything else fixed.

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
| `seats.ts` | exact match; dominance in one component only fails; booster ≠ child seat; empty configs never fit; slack picks the minimal dominating config; merged sum fits where singles fit but sum does not |
| `timeline.ts` | ride ending exactly at next start fails with buffer 30, passes with buffer 0; ride abutting maintenance needs buffer; gaps at week start/end; remove then re-add; **location**: after a relay-out block `locationAt` = destination, `isFree(w, home)` is false during the away gap and `isFree(w, dest)` is true; `add` rejects a block whose start location mismatches; `awayWindows()` reports the away gap |
| Seats (chauffeur) | chauffeur ride load = requests + (1,0,0): a 4-adult family fits a 5-seater as `keep` but not as `chauffeur`; per-leg check on a relay pair |
| Relay pairing | out 09:00 + back 12:00 same destination pair on one car and both are served; different `destination_id` (same zone) do **not** pair; back-leg earlier than out-leg end does not pair; back-leg on the next day does not pair (day end); unpaired out-leg is unmet with `UNMET_NO_RELAY_PARTNER` and suggestions `convertToRoundTrip`, `chauffeur`, …; pair ranked by the higher score; a round trip with `needsCarAtDestination=false` self-pairs when `keep` does not fit and leaves the car free at the destination for a third request's relay-back |
| Location / day end | a home-origin request cannot use a car parked away (`UNMET_CAR_AWAY` blocker); a relay-out whose only partner is on the next day is rejected; fixed ride with `overnightAck` away at day end passes invariants, without it emits `CAR_AWAY_AT_DAY_END`; temporary car never gets a relay leg |
| Chauffeur | occupancy = 2·travel + dwell (45 min travel, dwell 10 → 100 min → 7 slots); suggestion appears only when a shared car is free at home for that window; `stats.needsDriver` counts it; passenger one-way with no host gets `chauffeur` before `externalHint` |
| DST | week fixture containing the March/October transition day with 92/100 slots: a "day" flexibility resolves to the correct bounds; no slot arithmetic crosses days incorrectly; `dayEndSlot` correct on both transition days |
| Flexibility | asymmetric windows (−0/+60): shift only later; return flex without departure flex; `minDurationSlots` rejects clamp results that collapse the ride; earliest minimal shift wins ties; a pair's back-leg shifts later within flex to meet the out-leg |
| Merge | same zone passes; detour 21 min fails at limit 20; time window intersection at the boundary slot; host shift within host flex; fixed host never shifts; luggage 2 needs `large_trunk`; temporary car appears as host only; one-way `passenger` out-leg merges into a relay-out ride and into a keep ride's outbound, never into a return-only ride |
| Split legs | `needsCarAtDestination=false` gets X/Y hosts; X = Y collapses to merge; per-leg seat check; **relay + passenger**: out as relay (paired with another member's relay-back) and return as passenger in Y's ride — the car is free for Y's partner in between |
| Improvement | depth-1 relocation frees a car; depth-2 pair; budget exhaustion sets `budgetExhausted` and leaves output valid; fixed blocker skips car; a relay pair relocates as one unit; a relocation that would break a location chain is rejected; an ejection is emitted as a `shiftWithinFlex` suggestion, never applied |
| Policy | each rule's value range; `minmax` all-equal → 0; unknown rule type → warning; changing `rideType` weights flips the greedy order in a 2-request/1-car fixture; manual boost overrides; late penalty demotes |
| Determinism | `solve(input)` twice → deep-equal; shuffled input arrays → identical output |
| Live helpers | `matchFreedSlot`: one/many/zero candidates, flex placement into merged gap, one-way candidates excluded, freed window away from home matches nobody, never relocates an existing ride; `tryAutoApprove`: exact time only, picks tightest car, requires the car at home, returns `null` for every one-way shape and when the car is parked away |
| Performance | `perf-300x15.json` (seeded PRNG generator in `__fixtures__/gen.ts`): completes < 2 s, `budgetExhausted` may be true, invariants hold |

### 7.2 Property-based tests (`fast-check`)

Arbitrary inputs (1–12 cars, 0–120 requests, random configs, blocks, fixed rides):

1. No two rides on a car violate the buffer rule; no ride overlaps maintenance.
2. Every assignment's passenger sum (plus one adult for chauffeur rides) fits its car; luggage ≤ capacity.
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
- R5: blocker on C2 is R8 (12:30–14:30, flex ±30). Relocating R8 to C1 fails (R1 until 12:30, R4 from 13:00). Relocating R8 **within C2** to 12:00–14:00 (−30/−30, inside its flexibility) frees C2 from 14:30; R5 fits at 14:30–16:00 (departure +60, return +60, both within declared flexibility). Applied: R8 → C2 12:00–14:00 (`RELOCATED_FOR`, "הוזז ב-30 דקות מוקדם יותר כדי לפנות מקום לבקשה של מיכל"), R5 → C2 14:30–16:00 (`PLACED_SHIFTED`).

**Resulting assignments**

| Car | Rides (car origin → destination) |
|---|---|
| C1 | R1 Dana 08:00–12:00 (H→H) · R4 Avi 13:00–15:30 (H→H) |
| C2 | R8 Rina 12:00–14:00 (H→H, shift −30/−30) · R5 Michal 14:30–16:00 (H→H, shift +60/+60) |
| C3 | R3 Noa 09:00–09:45 (**H→BIN**, relay out) · *away in Binyamina 09:45–11:15* · R7 Eitan 11:15–12:00 (**BIN→H**, relay back) · block 13:00–17:00 |
| C4 | R6 Levi 09:00–17:30 (H→H) |

Every car chains (`destinationId` of each ride = `originId` of the next) and ends the day at H; `carsAway = [{C3, BIN, 09:45–11:15}]`. Buffers: C3 12:00 + 30 ≤ 13:00 (block) ✓; C2 14:00 + 30 ≤ 14:30 ✓; C1 12:00 + 30 ≤ 13:00 ✓.

**Unmet: R2 Yossi** (`UNMET_NO_CAR`; blockers C1:R1/R4, C2:R8/R5, C3:R3/R7 + block, C4:R6). Suggestions, in order:

1. `merge` (leg `both`) into R6's ride on C4 — same destination, detour 0; host times 09:00/17:30 lie inside Yossi's flexibility (shift +30/+30 for him, none for Levi); seats (4,2,0) + (1,0,0) = (5,2,0) ≤ {5,2,0}; luggage 1 ≤ 2. Proposed driver: **Levi** (host). `confidence = 1 − 0 − 0 − 60/480 = 0.875`. Reason: "הצטרפות לנסיעה של לוי לתל אביב, יציאה 09:00 וחזרה 17:30, ללא סטייה".
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
3. `matchFreedSlot` may use the candidate's declared flexibility; `tryAutoApprove` may not (a human is not in the loop, so only the exact requested time is approved). Neither displaces a placed ride. (confirmed)
4. Merge detour is estimated from destination travel minutes/distance differences, not from geography. Adding coordinates to destinations later would replace `detour()` in `merge.ts` only.
5. Fairness deficits and "usual car" are computed by the data layer and passed in; the solver defines only their range (0..1) and default (0.5); the lookback is the fairness rule's `lookbackWeeks` param (default 3). (confirmed)
6. Relay pairing matches on the exact `destination_id`; zone-level pairing would change `pairRelays()` only. (confirmed)
7. Relay pairing runs before scoring and ignores scores, so `peopleServed` can credit both legs of a pair without circularity (§3.5). (new in v0.3)
8. A lone relay leg is never placed by the solver (day-end rule); the Sadran resolves it via `convertToRoundTrip`, `chauffeur`, a merge or a deny. One-way requests are never auto-approved after publish (REQUIREMENTS §13.64). (new in v0.3)
9. `convertToRoundTrip` proposes the latest feasible return time on that car (the requester keeps the car as long as the day allows), not the earliest. (new in v0.3)

### 9.1 Implementation deviations (first solver-dev pass, 2026-09-06)

Recorded per CLAUDE.md hard rule 2 (docs move with the code). None contradict REQUIREMENTS; all are conservative simplifications of this document's algorithm sections, chosen to keep the search bounded and the first implementation reviewable. Follow-ups are welcome as separate, tested changes.

10. **Module file names** follow the caller's explicit deliverable list rather than §3's module-layout table: `seatFit.ts` (not `seats.ts`), `slots.ts` (folds in `normalize.ts`'s responsibilities: `toSlot`, flexibility resolution, `NormalizedRequest`/`NormalizedLeg`), `greedy.ts` (not `assign.ts`), `flexibility.ts` (not `flex.ts`), `splitLegs.ts` (not `split.ts`), `suggestions.ts` (not `suggest.ts`), plus two new files not in the original table: `invariants.ts` (assertInvariants, factored out of `index.ts`) and `live.ts` (`matchFreedSlot`/`tryAutoApprove`, factored out of `index.ts`). Public behavior is unchanged; `index.ts` re-exports everything.
11. **Relay pairing scope (§3.6.1) is narrower than described**: `pairRelays()` only pairs one-way (`one_way_to`/`one_way_from`) `relay` requests. A `round_trip` with `needsCarAtDestination = false` is tried as a single `keep` unit in the main greedy pass first (not pre-split into independent out/return legs for cross-pairing before scoring); only when that fails does `splitLegs.ts` resolve its legs independently, including the relay+relay self-pair and, via the still-unpaired one-way relay pool, the relay+passenger / passenger+relay combinations. This still satisfies every §7.1 unit-test-matrix scenario for split legs but does not attempt the more general pre-scoring cross-pairing the prose describes.
12. **`bestPlacementWithinFlex` (§3.7) matches the literal clamp formula**, which for a `both` (keep) leg means dep′ and ret′ are clamped independently toward their own preferred value and a gap is rejected outright if duration then fails — so a `keep` leg's *own* flex search can only ever confirm the unshifted `[D,R)` fits somewhere (a different car, or the same car's untouched slot), never a genuinely shifted window. Real shifted placements for `keep` legs (the R8/R5 case in §8) come from the improvement pass's dedicated same-car compression (`improve.ts`'s `closeGapSameCar`), not from this function — documented and unit-tested in `flexibility.test.ts`/`improve.test.ts`.
13. **`improve.ts` relocates only single round-trip (`keep`) placed rides.** A placed relay pair is treated as an immovable blocker (its car is skipped for that unit) and an unmet relay pair is not retried by the improvement pass. Depth-2 relocation and the ejection fallback are depth-1/2-blocker only, per §3.10's stated bounds.
14. **`merge.ts` host-shift search only covers `both` (keep) hosts**; a fixed host, or a host whose own leg is `out`/`return` only, never shifts (matches §3.8's "keeping `h`'s car free... at the new window" for the common case; the one-way-host-shift generalization is future work).
15. **The `perf-300x15` fixture is generated in-test** (`__tests__/perf.test.ts`, seeded `mulberry32` PRNG in `__fixtures__/gen.ts`) rather than checked in as a static `perf-300x15.input.json`, to keep the fixture file human-reviewable; the 300×15 shape and the `< 2s` assertion match §6/§7.1 exactly.
16. **Golden fixtures implemented in this pass**: `basic-4x8` (§8 worked example, reproduced exactly including the unmet suggestion order), `fixed-rides-only`, `all-unmet`, and the generated `perf-300x15`. `dst-spring`, `merge-detour-edge`, `split-legs`, `relay-unpaired`, `chauffeur`, and `needs-car-false-relay-passenger` are covered by the corresponding unit tests (`slots.test.ts`'s DST case, `merge.test.ts`'s detour-boundary case, `splitLegs.test.ts`) rather than by dedicated JSON fixture pairs; adding the remaining JSON pairs is future work, not a behavioral gap.
