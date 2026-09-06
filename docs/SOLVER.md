# carshare-nevo — Solver design

Status: **DRAFT v0.2** (2026-09-06, reconciled per CLAUDE.md "Consistency decisions"). Derives from `docs/REQUIREMENTS.md` v0.2 (§5, §6.2, §7, §8, §13); if the two disagree, REQUIREMENTS wins.

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
- **Request** `r`: requester `m(r)`, destination `dest(r)` (with `zone`, `distance_km`, `travel_minutes`, `public_transport_score`, or zone `unknown` for free text), ride type, legs, passengers `p(r) = (adults, childSeats, boosters)`, `luggage ∈ {0,1}`, `needsCarAtDestination`, flexibility intervals, submission time, late flag, optional manual boost.
  - **Legs.** A round trip has an **outbound** leg (leave kibbutz at departure `D`) and a **return** leg (arrive kibbutz at return `R`). A one-way request has a single leg. `legs(r) ∈ {out, return, both}`.
  - **Flexibility.** Independent intervals `FD(r) = [D − a, D + b]` and `FR(r) = [R − c, R + d]` (each side one of 0/15/30/60/120 min or "any time that day", which the caller resolves to the day's slot bounds).
- **Car** `c`: `type ∈ {shared, temporary}`, seat configurations `Q(c) = {(A, C, B)…}`, features (e.g. `large_trunk`), maintenance blocks (slot intervals), `luggageCapacity` (default 1; 2 with `large_trunk`).
- **Fixed rides**: pinned rides, applied/accepted proposals, temporary-car owner rides. Immutable inputs with a car, a window and passengers; the requests they serve are excluded from solving.
- **Policy**: `{ id, version, rules: {type, weight, params}[] }`.
- **Ride** (output): one car, one window `[s, e)`, one driver request, served requests, passenger totals.

### 1.2 Occupancy of a request

| Case | Car occupancy window |
|---|---|
| Round trip, `needsCarAtDestination = true` | `[D, R)` |
| Round trip, `needsCarAtDestination = false` | Either `[D, R)` as an own ride (fallback), **or** two passenger legs hosted by other rides (§3.9). |
| One-way to destination | `[D, D + 2·travel)` — driver drops off and returns (assumption; see §9). |
| One-way from destination | `[R − 2·travel, R)` |

Unknown `travel_minutes` → `config.defaultOneWayMinutes` (60). Every window is rounded outward to the grid and has `minDurationSlots = max(1, ceil(2·travel / 15))`.

### 1.3 Hard constraints

1. **No overlap.** For rides `x ≠ y` on the same car: `s_y ≥ e_x + buffer` or `s_x ≥ e_y + buffer`. The same rule applies between a ride and a maintenance block.
2. **Seat fit** (§3.3): `Σ p(r)` over the ride's requests is dominated by some configuration of the car. Each request's `adults` includes its own would-be driver; when a request rides along as a passenger, *all* of its adults/childSeats/boosters join the host's load (its former driver is now a passenger) and the host's driver is counted exactly once, inside the host request's own `adults`. Nothing is ever subtracted.
3. **Luggage**: number of luggage requests in a ride `≤ luggageCapacity(c)`.
4. **Temporary cars** are never assigned by the solver; they only appear as merge hosts for their owner's rides.
5. **Fixed rides** are never moved.
6. Placements stay inside the request's declared flexibility, except `shiftBeyondFlex` *suggestions* (≤ 2 h, consent required).
7. Merges require detour `≤ config.detour` (20 min / 15 km) and are never applied by the solver — they are suggestions (REQUIREMENTS §13.4).

### 1.4 Objective

Maximize `Σ_{served r} score(r)` (policy-weighted served requests) subject to the hard constraints. Secondary, lexicographically: minimize total shift minutes from preferred times; minimize detour minutes; minimize the number of cars that change relative to `previousAssignments`. The solver is a heuristic (ordered greedy + bounded local improvement), not an exact optimizer; the objective defines the tie-breakers and the tests, not a proof of optimality.

---

## 2. Input / output types

```ts
// src/solver/types.ts
export type Slot = number;               // 15-min index from week.startMs
export type Window = { start: Slot; end: Slot };   // half-open [start, end)
export type Passengers = { adults: number; childSeats: number; boosters: number };

export interface DayBounds { dayIndex: 0|1|2|3|4|5|6; startSlot: Slot; endSlot: Slot }

export interface Destination {
  id: string; zone: string;                 // 'unknown' for unclassified free text
  distanceKm?: number; travelMinutes?: number;
  publicTransportScore?: number;            // 0..1, 1 = excellent service
}

export interface Flexibility { earlierMin: number | 'day'; laterMin: number | 'day' }

export interface Request {
  id: string; memberId: string; departmentId: string;
  destinationId: string; rideType: string;
  legs: 'out' | 'return' | 'both';
  departureMs?: number; returnMs?: number;  // epoch ms, 15-min aligned
  flexDeparture: Flexibility; flexReturn: Flexibility;
  passengers: Passengers; coRiderMemberIds: string[];
  luggage: boolean; needsCarAtDestination: boolean;
  submittedAtMs: number; isLate: boolean;
  manualBoost?: { value: number; reason: string };   // value 0..1
  preferredCarId?: string;                  // carried over from a previous draft
}

export interface Car {
  id: string; name: string; type: 'shared' | 'temporary'; ownerMemberId?: string;
  seatConfigs: Passengers[]; features: string[]; luggageCapacity: number;
  maintenance: Window[];
}

export interface FixedRide {
  id: string; carId: string; window: Window;
  driverRequestId?: string; servedRequestIds: string[];
  passengers: Passengers; luggageCount: number; destinationId?: string;
  kind: 'pinned' | 'acceptedProposal' | 'temporaryOwner';
}

export interface PolicyRuleConfig { type: string; weight: number; params: unknown }
export interface Policy { id: string; version: number; rules: PolicyRuleConfig[] }

export interface SolverStats {
  fairness: Record<string, { deficit: number }>;      // memberId → 0..1, supplied by caller
  usualCarId: Record<string, string>;                 // memberId → carId
}

export interface SolverConfig {
  bufferMinutes: number;            // default 15
  detour: { maxMinutes: number; maxKm: number };      // default 20 / 15
  beyondFlexMaxMinutes: number;     // default 120
  defaultOneWayMinutes: number;     // default 60
  improvementBudget: number;        // max relocation evaluations, default 5000
  perRequestBudget: number;         // default 200
  externalHints: { cabMaxMinutes: number; rentalMinHours: number; ptMinScore: number };
}

export interface SolverInput {
  week: { startMs: number; days: DayBounds[] };
  cars: Car[]; requests: Request[]; fixedRides: FixedRide[];
  destinations: Record<string, Destination>;
  policy: Policy; stats: SolverStats; config: SolverConfig;
  previousAssignments?: Pick<Assignment, 'servedRequestIds' | 'carId'>[];
}

export interface Assignment {
  rideId: string; carId: string; window: Window;
  driverRequestId: string; servedRequestIds: string[];
  passengers: Passengers; luggageCount: number;
  shift: { departureMin: number; returnMin: number };   // signed, 0 if at preferred
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
  | (SuggestionBase & { kind: 'merge'; hostRideId: string; guestRequestIds: string[];
       proposedDriverRequestId: string; window: Window; hostShift?: { departureMin: number; returnMin: number };
       detourMinutes: number; detourKm: number })
  | (SuggestionBase & { kind: 'shiftBeyondFlex'; carId: string; window: Window;
       shift: { departureMin: number; returnMin: number } })
  | (SuggestionBase & { kind: 'splitLegs'; outbound: { hostRideId: string; departSlot: Slot };
       return: { hostRideId: string; arriveSlot: Slot } })
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
  warnings: { code: string; message: string; requestId?: string }[];
  stats: { served: number; unmet: number; relocations: number; budgetExhausted: boolean; elapsedMs: number };
}

export function solve(input: SolverInput): SolverOutput;
```

`cost` is a positive number, lower is better, comparable only within one `kind`; `confidence ∈ [0,1]` estimates the chance the suggestion is accepted (declared flexibility → high, beyond flex → lower, merge → depends on detour and passenger count). Suggestions are ordered by the REQUIREMENTS §7.1 kind rank, then `cost`, then `requestId`.

---

## 3. Algorithm

Module layout (one responsibility per file):

```
src/solver/
  index.ts        solve(), matchFreedSlot(), tryAutoApprove()
  types.ts        normalize.ts   seats.ts   timeline.ts
  policy/engine.ts   rules/index.ts   rules/<type>.ts
  assign.ts  flex.ts  merge.ts  split.ts  improve.ts  suggest.ts
  reasons.ts      Hebrew templates keyed by reasonCode
  __fixtures__/   __tests__/
```

### 3.1 Normalization (`normalize.ts`)

- `toSlot(ms) = floor((ms − week.startMs) / 900_000)`. Departure floors, return ceils; misalignment emits a warning `TIME_NOT_ALIGNED`.
- `'day'` flexibility resolves to `days[dayIndex(D)].startSlot … endSlot`. Because DST days are handled by the caller's `DayBounds`, the solver's arithmetic is uniform.
- Build `NormalizedRequest { window, minDurationSlots, flexDep: [lo, hi], flexRet: [lo, hi], durationFixed: boolean }`. For one-way legs `durationFixed = true` (only one shift dimension).
- Requests served by a `FixedRide` are marked `servedByFixed` and skipped; their fixed rides become `Assignment { source: 'fixed' }`.
- Validation warnings, never throws: return before departure, outside week, passenger set fits no active car (`NO_CAR_FITS_SEATS`).

### 3.2 Car timelines (`timeline.ts`)

```ts
export class CarTimeline {
  constructor(car: Car, bufferSlots: number, weekSlots: number);
  isFree(w: Window): boolean;                   // O(log n)
  gaps(): Window[];                             // free intervals, O(n)
  add(rideId: string, w: Window): void;         // O(n) insert into sorted array
  remove(rideId: string): void;
}
```

Every occupancy (ride, maintenance block, fixed ride) is stored as `[start, end + buffer)`. A candidate `[s, e)` is legal iff `[s, e + buffer)` is disjoint from all stored intervals — this yields exactly the symmetric rule of §1.3.1 with one binary search. Per car there are at most a few dozen intervals, so a sorted array beats a tree.

### 3.3 Seat fitting (`seats.ts`)

```ts
export function dominates(q: Passengers, p: Passengers): boolean;  // q.adults ≥ p.adults ∧ q.childSeats ≥ p.childSeats ∧ q.boosters ≥ p.boosters
export function fits(car: Car, p: Passengers): boolean;            // ∃ q ∈ car.seatConfigs: dominates(q, p)
export function slack(car: Car, p: Passengers): number | null;     // min over dominating q of Σ(q − p); null if !fits
export function sum(...ps: Passengers[]): Passengers;
```

Dominance is strictly component-wise; no substitutions are inferred (a booster child does not fit a child-seat position and vice versa). Configurations are enumerated by the admin exactly so that the solver never reasons about physical seat geometry.

**Seat accounting for merges (canonical; mirrored by the DB trigger in `DATA_MODEL.md` §5.2).** A request's `adults` includes its own would-be driver (REQUIREMENTS §5.1 "including the driver"). When guest `g` is merged as a passenger into host ride `h`, the ride's load is `sum(h.passengers, g.passengers)` — every adult, child seat and booster of `g` is added, because `g`'s former driver now sits as a passenger. The host's driver is counted once, inside `h.passengers.adults`. Example: host 1 adult, guest 2 adults + 1 child seat → load (3, 1, 0), which fits a `{3,1,0}` configuration of a 5-seater. `slack` drives the "tightest fit" heuristic; built-in child seats are informational only.

### 3.4 Hard-constraint predicate

```ts
export function canPlace(car: Car, tl: CarTimeline, req: NormalizedRequest, w: Window): boolean
// car.type === 'shared' && fits(car, req.passengers) && luggageOk(car, [req]) && tl.isFree(w)
```

### 3.5 Scoring (`policy/engine.ts`, details in §4)

`scoreRequests(input) → Map<requestId, { total, breakdown }>`. Requests are then sorted by `(−total, submittedAtMs, id)`. This order is the only place priority enters the greedy phase.

### 3.6 Ordered greedy assignment (`assign.ts`)

```
for r in sortedRequests:
  candidates = []
  for car in sharedCars sorted by id:
    if !fits(car, r.passengers) or !luggageOk: continue
    if tl[car].isFree(r.window): candidates.push({car, window: r.window, shift: 0})
  if candidates empty:
    for car in sharedCars: p = bestPlacementWithinFlex(tl[car], r); if p: candidates.push(p)
  if candidates empty: unmet.push(r); continue
  choose min by carChoiceKey; tl[car].add(...); assignments.push(...)
```

Preferred time is always tried first on every car; flexibility is used only when no car is free at the preferred time.

**Car choice key** (lexicographic, all deterministic):

1. `shiftCost = |departureShift| + |returnShift|` (minutes)
2. `slack(car, passengers)` — tightest seat fit, keeps large cars for large groups
3. continuity: `0` if `car.id === previousAssignment(r).carId`, else `1` if `car.id === stats.usualCarId[member]`, else `2`
4. fragmentation: leftover of the gap the ride lands in (`gap.length − ride.length`, best-fit) — avoids splitting a long free window
5. `car.id`

### 3.7 Flexibility search (`flex.ts`)

```ts
export function bestPlacementWithinFlex(tl: CarTimeline, r: NormalizedRequest): Placement | null
```

For each free gap `[g1, g2)` of the car, the feasible region is `dep' ∈ [max(flexDep.lo, g1), flexDep.hi]`, `ret' ∈ [flexRet.lo, min(flexRet.hi, g2 − buffer)]`, with `ret' − dep' ≥ minDurationSlots`. The minimal-shift point is `dep' = clamp(D, …)`, `ret' = clamp(R, …)` — O(1) per gap, no enumeration of the 96×96 shift pairs. If the duration constraint fails after clamping, the region is empty for that gap (both bounds are already the closest to the preferred). Across gaps and cars, order by `shiftCost`, then earlier departure, then the car key. For `durationFixed` legs the same computation runs in one dimension. Beyond-flex search (§3.11) is the same function with the intervals widened by `beyondFlexMaxMinutes`.

### 3.8 Merge candidate detection (`merge.ts`)

```ts
export function findMergeHosts(guest: NormalizedRequest, rides: Assignment[], ctx): MergeCandidate[]
```

A ride `h` (solver or fixed, including temporary-car owner rides) hosts guest `g` iff:

- **Destination compatibility:** same `destinationId`, or same `zone`, or `detour(h.dest, g.dest) ≤ config.detour`, where `detour` is estimated as `|travelMinutes_h − travelMinutes_g| + zonePenalty` and `|distanceKm_h − distanceKm_g|`; zone `unknown` never merges.
- **Time compatibility:** `h.departure ∈ FD(g)` and `h.return ∈ FR(g)` (for the legs `g` has). If not, and `h` is not fixed, try shifting `h` within its own flexibility to the nearest point that satisfies both (`hostShift`), keeping `h`'s car free at the new window.
- **Seats:** `fits(car_h, sum(h.passengers, g.passengers))`.
- **Luggage:** `h.luggageCount + g.luggage ≤ luggageCapacity(car_h)`.

`cost = detourMinutes + shiftCost(g) + shiftCost(h)`; `confidence = 1 − detour/maxDetour · 0.4 − 0.1·(guests already in h)`. The proposed driver is the host's driver unless the host request has `needsCarAtDestination = false` and the guest has `true`, in which case the guest is proposed as driver (REQUIREMENTS §13.9 allows the Sadran to set another driver).

Merges are never applied automatically. Two lists are produced: merges for unmet requests (as `Suggestion`) and `mergeOpportunities` between two *assigned* rides, ranked by freed car-slots, for the Sadran's information.

### 3.9 Split legs (`split.ts`)

For an unmet request with `needsCarAtDestination = false` and `legs = both`: find host `X` whose outbound leg matches (`X.departure ∈ FD(g)`, destination compatible, seats fit on X's outbound leg) and host `Y` whose return leg matches (`Y.return ∈ FR(g)`, seats fit on Y's return leg). `X = Y` is a plain merge and is reported as such. Passenger fit is checked per leg, so a family that rides out with X can still fit even if X picks up others on the way back. `cost = shiftCost + detour_X + detour_Y`, `confidence = 0.6 · min(conf_X, conf_Y)` (two consents).

### 3.10 Bounded local improvement (`improve.ts`)

Goal: serve an unmet request by **relocating** already-placed solver rides within their declared flexibility (consent-free per REQUIREMENTS §13.3). Fixed rides never move.

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

The search is depth ≤ 2, at most 2 blockers, and hard-capped by two counters; `stats.budgetExhausted` reports when a cap was hit. Relocations are recorded on the moved assignment (`reasonCode: RELOCATED_FOR`, Hebrew reason names the beneficiary). Ejecting a lower-priority ride to serve a higher-priority one is **not** done automatically (REQUIREMENTS §14.6); the greedy order already serves higher scores first, and when the improvement pass finds a solution only by ejecting, it emits it as a `shiftWithinFlex` suggestion with non-empty `relocations` instead of applying it.

### 3.11 Suggestion generation (`suggest.ts`)

For each remaining unmet request, in REQUIREMENTS §7.1 order:

1. `shiftWithinFlex` — only reachable via relocations the improvement pass declined to apply; otherwise absent.
2. `merge` — from §3.8, up to 3 hosts.
3. `shiftBeyondFlex` — `bestPlacementWithinFlex` with intervals widened by ≤ 2 h; `confidence = 0.5 − shiftCost/480`.
4. `splitLegs` — §3.9, only if `needsCarAtDestination = false`.
5. `externalHint` — `cab` if single leg or occupancy ≤ `cabMaxMinutes` (90) and `distanceKm ≤ 30`; `rental` if occupancy ≥ `rentalMinHours` (30, spans days); `publicTransport` if `public_transport_score ≥ ptMinScore` (0.6).
6. `deny` — always present, last, with the blockers listed in the reason.

### 3.12 Post-conditions

Before returning, `assertInvariants(output)` checks no-overlap per car (including buffer and maintenance), seat fit for every ride, every request appears exactly once (assignment, unmet, or servedByFixed), fixed rides unchanged. A violation throws `SolverInvariantError` — the caller shows an error and keeps the previous draft.

### 3.13 Explainability

Every assignment, unmet record and suggestion has a `reasonCode` and a Hebrew `reason` rendered by `reasons.ts` from a template plus params (car name, times, member names supplied via `input`). `reasons.ts` is the **only** file under `src/solver` that contains Hebrew (CLAUDE.md hard rule 3): it also holds the rule descriptions shown in the admin UI (`RULE_<TYPE>_DESC`) and the `PolicyParamsError` messages, keyed by code. Examples:

| Code | Hebrew template |
|---|---|
| `PLACED_PREFERRED` | `שובץ ל{car} בזמן המבוקש` |
| `PLACED_SHIFTED` | `שובץ ל{car} עם הזזה של {dep} ביציאה ו-{ret} בחזרה, בתוך הגמישות שהוצהרה` |
| `RELOCATED_FOR` | `הועבר ל{car} כדי לפנות מקום לבקשה של {member}` |
| `UNMET_NO_CAR` | `אין רכב פנוי בחלון המבוקש; חוסמים: {blockers}` |
| `SUGGEST_MERGE` | `הצטרפות לנסיעה של {host} ל{dest} ביציאה {dep} ובחזרה {ret}, ללא סטייה` |
| `SUGGEST_BEYOND_FLEX` | `הזזה של {dep} מעבר לגמישות שהוצהרה — דורש הסכמה` |
| `SUGGEST_DENY` | `לא נמצא פתרון; ניתן לדחות עם הסבר` |

### 3.14 Determinism

No randomness, no clock reads (`elapsedMs` is measured by the caller-supplied `now?: () => number` for stats only). Every sort uses a total-order comparator that ends in an `id` comparison. Inputs are sorted by `id` at normalization so `Map` iteration order is stable. Floating-point scores are summed in rule-registry order after rounding rule values to 6 decimals.

### 3.15 Suggestion kind → proposal type (canonical mapping)

The solver emits `Suggestion.kind`; the board turns an accepted suggestion into either a direct board edit or a `proposals` row (`proposal_type` enum, `DATA_MODEL.md` §3.8). This table is the single definition; `DATA_MODEL.md` (proposals) and `UX_FLOWS.md` §4.3 (composer) reference it.

| `Suggestion.kind` | `proposal_type` | Consent | Payload / notes |
|---|---|---|---|
| `shiftWithinFlex` | **none** — applied directly to the draft (board action **החל**) | none beyond the declared flexibility (REQUIREMENTS §13.3); the member is informed at publish | includes `relocations` of other rides, all within their own flexibility |
| `shiftBeyondFlex` | `shift` | requester | `{depart_at, return_at}` from `window` |
| `merge` | `merge` | every member in the ride (REQUIREMENTS §7.3) | `{ride_id: hostRideId, role, legs: [{leg:'both', ride_id}], detour_minutes}`; `proposedDriverRequestId` decides `role` |
| `splitLegs` | `merge` | requester + both hosts' members | same shape with **two** entries: `legs: [{leg:'out', ride_id: outbound.hostRideId}, {leg:'return', ride_id: return.hostRideId}]` |
| `externalHint` | `external` | requester ("found another solution") | `{hint: 'cab' \| 'rental' \| 'public_transport', reason}`; the Sadran may also pick `private` manually |
| `deny` | `deny` | requester acknowledges | `{reason}` with the blockers |

`shiftWithinFlex` never produces a proposal because the member already consented (REQUIREMENTS §7.1 item 1); everything else needs an answer via `/p/<token>` or a Sadran-recorded answer.

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
| `peopleServed` | `{ cap: number }` | `min((adults + childSeats + boosters − 1) / cap, 1)` |
| `fairness` | `{ lookbackWeeks: number }` | `stats.fairness[member].deficit` (0..1, computed by the caller for the lookback; missing → 0.5) |
| `submissionTime` | `{ latePenalty: number }` | on time: `1 − 0.3 · rank/N` by `submittedAtMs`; late: `max(0, 0.7 − latePenalty)` |
| `flexibilityOffered` | `{ fullCreditMinutes: number }` | `min(totalDeclaredFlexMinutes / fullCreditMinutes, 1)`; `'day'` counts as 480 |
| `manualBoost` | `{}` | `request.manualBoost?.value ?? 0` |

"Late penalty" is thus part of `submissionTime` (a policy param, not a department setting); "manual boost" is an ordinary rule whose value comes from the request, so a Sadran boost only has effect if the policy includes the rule with a weight (default 2.0). `rideType.weights` is keyed by `ride_types.code` (`work`, `childcare`, `healthcare`, `errands`, `other`); `fairness.lookbackWeeks` defaults to `department_settings.fairness_lookback_weeks` (8). This JSON is what `supabase/seed.sql` inserts as `policy_versions` v1 of the global default.

### 4.4 Example policy

```json
{ "id": "nevo-default", "version": 3, "rules": [
  { "type": "rideType", "weight": 1.0, "params": { "weights": { "healthcare": 10, "work": 8, "childcare": 8, "other": 5, "errands": 3 } } },
  { "type": "distance", "weight": 0.4, "params": { "maxKm": 60 } },
  { "type": "publicTransport", "weight": 0.3, "params": {} },
  { "type": "peopleServed", "weight": 0.3, "params": { "cap": 4 } },
  { "type": "fairness", "weight": 0.5, "params": { "lookbackWeeks": 8 } },
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

Post-publish the solver is **never** run automatically. Two small functions cover REQUIREMENTS §8:

```ts
export interface FreedSlotInput {
  car: Car; timeline: CarTimeline;             // car's remaining rides + maintenance, cancelled ride removed
  freedWindow: Window;
  candidates: Request[];                       // waitlisted/denied, same department, not opted out (caller filters)
  destinations: Record<string, Destination>; policy: Policy; stats: SolverStats; config: SolverConfig;
  week: SolverInput['week'];
}
export interface FreedSlotCandidate { requestId: string; window: Window; shift: { departureMin: number; returnMin: number }; score: number; reason: string }
export function matchFreedSlot(input: FreedSlotInput): FreedSlotCandidate[];
```

A candidate qualifies if its flexible envelope intersects `freedWindow`, its passengers fit the car, luggage fits, and `bestPlacementWithinFlex(timeline, r)` finds a window (the freed window may merge with adjacent free time — the timeline, not the freed window alone, decides). Results are ordered by `(−score, shiftCost, id)`. The caller applies §8: one candidate → auto-assign and notify; several → push all and the Sadran; none → slot stays free.

```ts
export interface AutoApproveInput {
  request: Request; cars: Car[]; timelines: Record<string, CarTimeline>;   // all rides incl. published
  config: SolverConfig; stats: SolverStats; week: SolverInput['week'];
}
export function tryAutoApprove(input: AutoApproveInput): Assignment | null;
```

`tryAutoApprove` places the request **only at its preferred time** (no shift, no relocation, no merge) on a shared car chosen by the §3.6 key; `null` means `waitlisted`. The **authoritative** auto-approve runs in SQL: `submit_request()` calls `try_auto_approve()` inside the transaction and the exclusion constraint is the final arbiter (`ARCHITECTURE.md` §6.4, `DATA_MODEL.md` §6 step 16). This TS function is the reference implementation that the SQL mirrors (shared fixtures) and powers the request form's "will be approved immediately" preview. Likewise `matchFreedSlot` is called by the `on-ride-cancelled` edge function over candidates pre-filtered by the SQL `freed_slot_candidates()`; the outcome is written by `resolve_freed_offer()`. Edits of an assigned ride use `timeline.isFree(newWindow)` on the same car (with the old ride removed); otherwise the caller treats it as cancel + new request. "Car goes to maintenance": the caller re-runs `solve()` with only the affected requests open and everything else fixed.

---

## 6. Complexity and performance budget

Let `R = 300` requests, `C = 15` cars, `K ≈ R/C ≈ 20–40` rides per car.

| Phase | Cost | Estimate |
|---|---|---|
| Normalize + score | `O(R · rules)` | < 5 ms |
| Sort | `O(R log R)` | negligible |
| Greedy: preferred check | `O(R · C · log K)` | ~ 20k binary searches |
| Greedy: flex search | `O(R · C · K)` O(1) per gap | ≤ 180k gap evaluations |
| Merge detection | `O(U · R)` with zone pre-filter (`Map<zone, rides[]>`) | ≤ 90k for 300 unmet worst case |
| Improvement | bounded by `improvementBudget` (5000 placements) | ≤ 5000 · O(K) |
| Suggestions | `O(U · C · K)` | as flex search |
| Invariant check | `O(R log R)` | negligible |

Data structures: sorted interval arrays per car (`CarTimeline`), `Map<zone, Assignment[]>` for merge hosts, plain arrays sorted by id elsewhere. Expected runtime well under 1 s in a mid-range phone browser; the CI performance test asserts < 2 s on the 300×15 fixture to leave margin under the 10 s requirement. Memory is O(R + C·K).

---

## 7. Test plan (Vitest)

### 7.1 Unit test matrix

| Area | Cases |
|---|---|
| `seats.ts` | exact match; dominance in one component only fails; booster ≠ child seat; empty configs never fit; slack picks the minimal dominating config; merged sum fits where singles fit but sum does not |
| `timeline.ts` | ride ending exactly at next start fails with buffer 15, passes with buffer 0; ride abutting maintenance needs buffer; gaps at week start/end; remove then re-add |
| DST | week fixture containing the March/October transition day with 92/100 slots: a "day" flexibility resolves to the correct bounds; no slot arithmetic crosses days incorrectly |
| Flexibility | asymmetric windows (−0/+60): shift only later; return flex without departure flex; `minDurationSlots` rejects clamp results that collapse the ride; earliest minimal shift wins ties |
| Merge | same zone passes; detour 21 min fails at limit 20; time window intersection at the boundary slot; host shift within host flex; fixed host never shifts; luggage 2 needs `large_trunk`; temporary car appears as host only |
| Split legs | `needsCarAtDestination=false` gets X/Y hosts; X = Y collapses to merge; per-leg seat check |
| Improvement | depth-1 relocation frees a car; depth-2 pair; budget exhaustion sets `budgetExhausted` and leaves output valid; fixed blocker skips car |
| Policy | each rule's value range; `minmax` all-equal → 0; unknown rule type → warning; changing `rideType` weights flips the greedy order in a 2-request/1-car fixture; manual boost overrides; late penalty demotes |
| Determinism | `solve(input)` twice → deep-equal; shuffled input arrays → identical output |
| Live helpers | `matchFreedSlot`: one/many/zero candidates, flex placement into merged gap; `tryAutoApprove`: exact time only, picks tightest car |
| Performance | `perf-300x15.json` (seeded PRNG generator in `__fixtures__/gen.ts`): completes < 2 s, `budgetExhausted` may be true, invariants hold |

### 7.2 Property-based tests (`fast-check`)

Arbitrary inputs (1–12 cars, 0–120 requests, random configs, blocks, fixed rides):

1. No two rides on a car violate the buffer rule; no ride overlaps maintenance.
2. Every assignment's passenger sum fits its car; luggage ≤ capacity.
3. Every open request appears exactly once in `assignments ∪ unmet`.
4. Every solver placement lies inside the request's declared flexibility.
5. Fixed rides are returned byte-identical.
6. `solve` is idempotent on its own output when all assignments are passed back as fixed rides (zero changes).

### 7.3 Golden fixtures

`src/solver/__fixtures__/<name>.input.json` + `<name>.expected.json`, compared with `toEqual` (not snapshots, so diffs are reviewed): `basic-4x8` (§8 below), `dst-spring`, `merge-detour-edge`, `split-legs`, `fixed-rides-only`, `all-unmet`, `perf-300x15`.

---

## 8. Worked example (fixture `basic-4x8`)

All rides on Monday; buffer 15 min; policy of §4.4; fairness deficits: Yossi 0.2, Michal 0.9, Eitan 0.7, others 0.5; Dana's usual car is C3.

**Cars**

| Car | Seat configs | Features | Blocks |
|---|---|---|---|
| C1 Picanto | {4,0,0} {2,1,0} {3,0,1} | — | Mon 05:00–07:00 |
| C2 Octavia | {5,0,0} {3,1,0} {2,2,0} {4,0,1} | large_trunk | — |
| C3 Corolla | {5,0,0} {3,1,0} {4,0,1} | — | — |
| C4 Staria | {7,0,0} {5,2,0} {4,2,1} {6,0,1} | large_trunk | — |

**Destinations**: Tel Aviv (zone TA, 55 km, 60 min, PT 0.7); Beer Sheva (BS, 40 km, 45 min, PT 0.5); Ashkelon clinic (ASH, 25 km, 30 min, PT 0.3); Sderot (SDR, 12 km, 15 min, PT 0.4).

**Requests**

| Id | Member | Type | Dest | Window | Passengers | Flex dep / ret | Notes |
|---|---|---|---|---|---|---|---|
| R1 | Dana | Healthcare | ASH | 08:00–12:00 | 1A | 0 / 0 | |
| R2 | Yossi | Work | TA | 07:30–17:00 | 1A | ±30 / ±30 | |
| R3 | Noa | Work | TA | 08:00–16:30 | 1A | ±30 / ±60 | needsCar = **no** |
| R4 | Avi | Childcare | BS | 13:00–15:30 | 2A+1CS | 0 / 0 | |
| R5 | Michal | Errands | BS | 13:30–15:00 | 1A | −30/+60 / −30/+60 | |
| R6 | Levi | Other | TA | 09:00–20:00 | 4A+2CS | 0 / 0 | luggage |
| R7 | Eitan | Work | SDR | 16:30–19:00 | 1A | 0 / 0 | |
| R8 | Rina | Healthcare | ASH | 12:30–14:30 | 1A+1B | ±15 / ±15 | **late** |

**Scores** (weight × normalized value; see §4.3):

| Id | rideType | distance | PT | people | fairness | submission | flex | total |
|---|---|---|---|---|---|---|---|---|
| R3 | 0.80 | 0.368 | 0.09 | 0 | 0.25 | 0.20 | 0.15 | **1.858** |
| R1 | 1.00 | 0.168 | 0.21 | 0 | 0.25 | 0.20 | 0 | **1.828** |
| R4 | 0.80 | 0.268 | 0.15 | 0.15 | 0.25 | 0.20 | 0 | **1.818** |
| R8 | 1.00 | 0.168 | 0.21 | 0.075 | 0.25 | 0 (late) | 0.05 | **1.753** |
| R6 | 0.50 | 0.368 | 0.09 | 0.30 | 0.25 | 0.20 | 0 | **1.708** |
| R2 | 0.80 | 0.368 | 0.09 | 0 | 0.10 | 0.20 | 0.10 | **1.658** |
| R7 | 0.80 | 0.080 | 0.18 | 0 | 0.35 | 0.20 | 0 | **1.610** |
| R5 | 0.30 | 0.268 | 0.15 | 0 | 0.45 | 0.20 | 0.15 | **1.518** |

**Greedy pass** (order R3, R1, R4, R8, R6, R2, R7, R5):

1. R3 → **C1** 08:00–16:30 at preferred (all cars free; C1 has the tightest slack 3).
2. R1 → **C3** 08:00–12:00 (C2/C3 tie on slack 4; continuity: Dana's usual car).
3. R4 (2,1,0) → **C3** 13:00–15:30 (C2/C3 both slack 1 via {3,1,0}; best-fit prefers C3's already-fragmented day; 12:00 + 15 min buffer ≤ 13:00).
4. R8 (1,0,1) → **C2** 12:30–14:30 at preferred (C1 busy, C3 busy until 12:15 and again from 13:00; C2 slack 3 beats C4 slack 5).
5. R6 (4,2,0) + luggage → **C4** 09:00–20:00 (only car whose configs dominate; free).
6. R2 07:30–17:00: no car free at preferred; flex envelope 07:00–17:30 finds no gap on any car → **unmet (for now)**.
7. R7 → **C3** 16:30–19:00 (C2 free from 14:45, C3 free from 15:45; tie on slack, best-fit picks the smaller leftover on C3).
8. R5 13:30–15:00: C2 busy until 14:45 (R8 + buffer), latest allowed departure 14:30 → no placement within flex → **unmet (for now)**.

**Improvement pass** (unmet by score: R2, then R5):

- R2 needs ~9.5 h inside 07:00–17:30. Every car has a blocker; on C2 the blocker R8 (flex ±15) cannot relocate to C3 (R1 until 12:15, R4 from 13:00) or C4. 2 evaluations, no solution.
- R5: blocker on C2 is R8. Shifting R8 within its own flexibility to 12:15–14:15 frees C2 from 14:30; R5 fits at 14:30–16:00 (departure +60, return +60, both within declared flexibility). Applied: R8 → C2 12:15–14:15 (`RELOCATED_FOR`, "הוזז ב-15 דקות מוקדם יותר כדי לפנות מקום לבקשה של מיכל"), R5 → C2 14:30–16:00 (`PLACED_SHIFTED`).

**Resulting assignments**

| Car | Rides |
|---|---|
| C1 | R3 Noa 08:00–16:30 |
| C2 | R8 Rina 12:15–14:15 (shift −15/−15) · R5 Michal 14:30–16:00 (shift +60/+60) |
| C3 | R1 Dana 08:00–12:00 · R4 Avi 13:00–15:30 · R7 Eitan 16:30–19:00 |
| C4 | R6 Levi 09:00–20:00 |

**Unmet: R2 Yossi** (`UNMET_NO_CAR`; blockers C1:R3, C2:R8/R5, C3:R1/R4/R7, C4:R6). Suggestions, in order:

1. `merge` into R3's ride on C1 — same destination, detour 0; host times 08:00/16:30 lie inside Yossi's flexibility (shift +30/−30 for him, none for Noa); seats (2,0,0) ≤ {4,0,0}. Proposed driver: **Yossi**, because Noa does not need the car at the destination and Yossi does. `confidence 0.9`. Reason: "הצטרפות לנסיעה של נועה לתל אביב, יציאה 08:00 וחזרה 16:30; מוצע שיוסי ינהג כי הוא זקוק לרכב ביעד".
2. `shiftBeyondFlex` — none: even with ±2 h no car has a matching gap (omitted).
3. `externalHint: publicTransport` — Tel Aviv PT score 0.7 ≥ 0.6. `confidence 0.3`.
4. `deny` — "לא נמצא רכב פנוי; ניתן לדחות".

**Merge opportunities** (informational): R5 → R4 on C3 (same zone BS; R4's 13:00/15:30 inside Michal's declared windows; seats (3,1,0) fits {3,1,0}; detour 0) would free C2 14:30–16:00 — not enough for R2, so it is listed but not attached to any unmet request.

Why Yossi is the one left out is visible in the breakdown: his low fairness deficit (0.2, many rides recently) costs him 0.15 relative to the default, which places him below R6 and R8 in the greedy order; the Sadran can override with a manual boost and re-solve.

---

## 9. Assumptions introduced by this document

Collected for the product owner in `REQUIREMENTS.md` §13 items 14–24 (review them there).

1. One-way requests block the car for `2 × travel_minutes` (driver goes and comes back). If in practice one-way requests are mostly "drop me off" rides served by someone else, they should be modelled as passenger legs with no own occupancy.
2. The turnaround buffer also applies between a ride and a maintenance block.
3. `matchFreedSlot` may use the candidate's declared flexibility; `tryAutoApprove` may not (a human is not in the loop, so only the exact requested time is approved).
4. Merge detour is estimated from destination travel minutes/distance differences, not from geography. Adding coordinates to destinations later would replace `detour()` in `merge.ts` only.
5. Fairness deficits and "usual car" are computed by the data layer and passed in; the solver defines only their range (0..1) and default (0.5).
