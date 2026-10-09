// src/solver/types.ts
//
// Pure TypeScript types for the scheduling solver (docs/SOLVER.md §2).
// No DOM / React / Supabase imports here or anywhere in src/solver.
//
// String literal unions that mirror SQL enums (docs/DATA_MODEL.md §2) use the
// same spellings as the DB: TripShape = trip_shape, LegSide = ride_leg,
// LegCarMode = leg_car_mode.

export type Slot = number; // 15-minute index from week.startMs
export interface Window {
  start: Slot;
  end: Slot;
} // half-open [start, end)

export interface Passengers {
  adults: number;
  childSeats: number;
  boosters: number;
}

export interface DayBounds {
  dayIndex: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  startSlot: Slot;
  endSlot: Slot;
  /** department_settings.day_end_time on that day (default 23:59 -> endSlot - 1) */
  dayEndSlot: Slot;
}

/** = SQL trip_shape */
export type TripShape = 'round_trip' | 'one_way_to' | 'one_way_from';
/** = SQL ride_leg */
export type LegSide = 'out' | 'return' | 'both';
/** = SQL leg_car_mode */
export type LegCarMode = 'keep' | 'relay' | 'passenger' | 'chauffeur';

/**
 * = SQL trip_type (REQUIREMENTS §13.93, docs/ORIGINS_PLAN_2026-10.md §1/§4).
 * Member-facing labels (Hebrew, see docs/SOLVER.md and reasons.ts) are
 * round trip, one-way-only and drop-off, in that order.
 * When a `Request` omits `tripType` (legacy/bridge input), `effectiveTripType()`
 * derives it from the legacy fields exactly as the SQL backfill does: any
 * one-way shape (`one_way_to`/`one_way_from`) or a round trip with
 * `needsCarAtDestination = false` becomes `drop_off` (today's relay/
 * chauffeur/passenger behavior, now origin-aware); everything else is
 * `round_trip`. The NEW `one_way` value is only ever produced by an explicit
 * `tripType: 'one_way'` on the input (a future bridge concern, O5) — no
 * legacy combination of fields derives it, so every existing golden fixture
 * and the one-way pairing parity suite keep deriving `drop_off` unchanged.
 */
export type TripType = 'round_trip' | 'one_way' | 'drop_off';

/** One row of `SolverInput.travel` (REQUIREMENTS §13.93, ORIGINS_PLAN §4). Symmetric. */
export interface TravelEdge {
  fromId: string;
  toId: string;
  distanceKm?: number;
  travelMinutes?: number;
}

export interface Destination {
  id: string;
  /** Display name for reason texts (SOLVER §3.13a); never the id. */
  name?: string;
  /** 'unknown' for unclassified free text; 'home' for the department base */
  zone: string;
  distanceKm?: number;
  travelMinutes?: number;
  /** 0..1, 1 = excellent service */
  publicTransportScore?: number;
}

export interface Flexibility {
  earlierMin: number | 'day';
  laterMin: number | 'day';
}

/**
 * REQ §13.112 (a): a request's plan B — always a drop-off: be at the drop place by `arriveByMs`, and
 * (when `pickupMs` is set) be picked up from the SAME place at `pickupMs`. Never changes how the main request is placed;
 * the solver only tests, after the main placement, whether it could be served this way (`useAlternative`, SOLVER §3.15).
 */
export interface AlternativePlan {
  /** list place, or the free-text sentinel when `dropPlaceIsFreeText` */
  dropPlaceId: string;
  dropPlaceIsFreeText?: boolean;
  dropPlaceText?: string;
  /** epoch ms, 15-min aligned: be at the drop place by this time */
  arriveByMs: number;
  /** epoch ms, 15-min aligned: leave the drop place (be picked up) at this time; absent = no pickup */
  pickupMs?: number;
  /** Pickup from another place than the drop place (REQ §13.112 a); absent = the drop place. */
  pickupPlaceId?: string;
  pickupPlaceIsFreeText?: boolean;
  pickupPlaceText?: string;
}

/** = SQL request_fallback (REQ §13.112): what the member wants when no car is found. */
export type RequestFallback = 'none' | 'alternative' | 'manage';

export interface Request {
  /** Internal (dropOffSplit.ts, REQUIREMENTS §13.95 H2): id of the original request this half of a split drop-off-with-pickup came from. Never output. */
  splitFrom?: string;
  id: string;
  memberId: string;
  /** Requester display name, used only in reason texts (SOLVER §3.13a). */
  memberName?: string;
  /** Free-text destination/origin labels (reason texts only; the id is a sentinel). */
  destinationText?: string;
  originText?: string;
  departmentId: string;
  destinationId: string;
  rideType: string;
  tripShape: TripShape;
  /**
   * Where this trip starts (REQUIREMENTS §13.93). Undefined means the
   * department home (`SolverInput.homeLocationId`) — the only value every
   * request had before this field existed, so omitting it is fully
   * backward-compatible. Use `originIdOf(request, homeLocationId)` rather
   * than reading this field directly.
   */
  originId?: string;
  /** `originId` is free text, not a managed place — such a request is never placed (§4 item 5). */
  originIsFreeText?: boolean;
  /** `destinationId` is the free-text pseudo place, not a managed one: a car can never wait there, so such legs never form a relay pair (REQ §13.58). */
  destinationIsFreeText?: boolean;
  /**
   * New explicit trip type (REQUIREMENTS §13.93). Undefined means "derive
   * from the legacy fields" — see `TripType`/`effectiveTripType()`. Only an
   * explicit `'one_way'` changes solver behavior (no pairing obligation, no
   * chauffeur fallback, end-check-only placement); everything else behaves
   * exactly like today's `drop_off`-equivalent legacy handling.
   */
  tripType?: TripType;
  /**
   * Deprecated input (REQUIREMENTS §13.88, rule made precise 2026-09-16): the
   * member never chose this on the form, and the stored value is now *ignored
   * entirely*, for drivers and non-drivers alike — pairing decides the mode,
   * not the member (§1.3.10a). The field stays in the type only so legacy/DB
   * rows deserialize without error; nothing in `src/solver` reads it anymore.
   */
  oneWayCarMode?: 'relay' | 'passenger';
  /** epoch ms, 15-min aligned; absent for one_way_from */
  departureMs?: number;
  /** epoch ms, 15-min aligned; absent for one_way_to */
  returnMs?: number;
  flexDeparture: Flexibility;
  flexReturn: Flexibility;
  /**
   * REQ §13.112 (c): "N hours somewhere between A and B" — a single-day round trip whose car block keeps its
   * length. Stored as the earliest block (`departureMs`..`returnMs`) with equal later-only flexibility on both
   * ends (`flexDeparture.laterMin === flexReturn.laterMin`, early 0). Wherever the solver moves such a request
   * (placement, relocation, a host's merge shift, a beyond-flexibility suggestion) both ends move by the same
   * amount; only a `tripType === 'round_trip'` request honours it (docs/SOLVER.md §3.7a).
   */
  durationLocked?: boolean;
  /**
   * REQ §13.112 (a)/(b): `'alternative'` = the member stated a plan B (`alternative`); `'manage'` ("I will manage") = no useful
   * fallback — the solver offers no `externalHint` for it (a `deny` stays). Undefined = `'none'`. Only a `round_trip` or
   * `one_way` request has an active fallback; the bridge omits both fields otherwise.
   */
  fallback?: RequestFallback;
  alternative?: AlternativePlan;
  /** REQ §13.112 (a): an accepted plan B already serves this request (scoring only: it counts `alternativeServedWeight` served). */
  servedByAlternative?: boolean;
  /** REQ §13.112 (a): the pickup-leg sibling of a plan B with a pickup from another place — scoring only: the pair counts once (this request weighs 0). */
  planBSibling?: boolean;
  passengers: Passengers;
  coRiderMemberIds: string[];
  luggage: boolean;
  /** round trips only */
  needsCarAtDestination: boolean;
  submittedAtMs: number;
  isLate: boolean;
  manualBoost?: { value: number; reason: string };
  preferredCarId?: string;
  /**
   * Whether this member may be given a driver role (REQUIREMENTS §13.88, owner
   * 2026-09-15/16; `profiles.does_not_drive`, self-service/admin-editable).
   * Default `true` ("everyone can drive unless they say otherwise"). `false`:
   * never a `keep` round trip driven by this requester and never a `relay` leg
   * driven by them — a round trip that would otherwise be `keep` is placed as
   * a driverless assignment (`PLACED_NEEDS_DRIVER`) or merged as a passenger
   * into a same-way ride (suggestion only, never auto-applied); a one-way leg
   * with no eligible driver on board (see `drivingCompanionIds`) resolves to
   * `passenger`, falling back to `chauffeur` (§3.11 item 5) when no host exists.
   */
  canDrive?: boolean;
  /**
   * Ids of named companions on this request who can drive (REQUIREMENTS §13.88,
   * owner 2026-09-16: "a driving companion becomes the driver automatically").
   * Only matters when `canDrive === false`: the leg then still has "an eligible
   * driver on board" (§1.3.10a) if this list is non-empty, and the solver names
   * the lexicographically-first id as `Assignment.driverMemberId`/
   * `AssignmentLeg`'s implied driver instead of the (non-driving) requester.
   * Absent/empty = no driving companion. Irrelevant when `canDrive !== false`.
   */
  drivingCompanionIds?: string[];
  /**
   * Multi-day series (SOLVER §3.x): one DB request row per calendar day,
   * sharing `seriesId`; `seriesIndex` is 1-based over the whole series,
   * `seriesCount` its total length. The solver only ever sees the legs that
   * fall inside the week being solved — a series may start mid-week
   * (`seriesIndex === 1` for the first in-week leg) or continue from a
   * previous week (`seriesIndex > 1` for the first in-week leg, in which
   * case the car is not at home at week start). All three are present
   * together or not at all.
   */
  seriesId?: string;
  seriesIndex?: number;
  seriesCount?: number;
  /**
   * Multi-stop rides (REQUIREMENTS §13.93 "Multi-stop rides", ORIGINS_PLAN
   * §6, docs/SOLVER.md §3.1a): extra waypoints on the out and/or return leg,
   * in route order (array order, filtered by `leg` — there is no separate
   * position field). `locationId` undefined = a free-text stop (never
   * matched by `travelBetween`/merge joining; always `config.defaultTravelMinutes`
   * on both adjoining hops). Read only via `legRoute()`/`legRouteMinutes()`/
   * `stopEtas()` (`src/solver/travel.ts`), never indexed directly.
   */
  stops?: { leg: 'out' | 'return'; locationId?: string }[];
}

export interface Car {
  id: string;
  name: string;
  type: 'shared' | 'temporary';
  ownerMemberId?: string;
  seatConfigs: Passengers[];
  features: string[];
  /** > 0 = the car has a large trunk (takes any number of large-luggage requests); 0 = none. Not a count cap. */
  luggageCapacity: number;
  maintenance: Window[];
  /** where the car is at week start; default = home */
  startLocationId?: string;
  /**
   * The car's home base (REQUIREMENTS §13.93, ORIGINS_PLAN §1): undefined =
   * the department home (`SolverInput.homeLocationId`). A car stays wherever
   * its last ride left it across days/weeks regardless of this field — it is
   * only used by `weekEndAway()` to decide whether the week ends with the
   * car somewhere other than where it "belongs".
   */
  baseLocationId?: string;
  /**
   * Kilometres this car drove in the rolling window before this week (F5,
   * docs/SOLVER.md §3.6.2; from the `car_mileage_totals` SQL RPC via
   * `buildSolverInput`). Optional and opt-in: when every car omits it, car
   * choice is byte-for-byte identical to before this field existed — it only
   * ever acts as the last tie-break before `car.id`, after every other
   * consideration (preferred car, seat fit, continuity, fragmentation).
   */
  mileageKm?: number;
}

export interface AssignmentLeg {
  requestId: string;
  leg: LegSide;
  carMode: LegCarMode;
  /** where the *requester* travels: out = home -> dest, return = dest -> home, both = home -> dest (and back) */
  originId: string;
  destinationId: string;
  role: 'driver' | 'passenger';
}

export interface FixedRide {
  id: string;
  carId: string;
  window: Window;
  originId: string;
  destinationId: string;
  driverRequestId?: string;
  /** Driverless pinned reservations still block the car's timeline. */
  driverMemberId?: string;
  legs: AssignmentLeg[];
  servedRequestIds: string[];
  passengers: Passengers;
  luggageCount: number;
  /** Sadran acknowledged the car is not home at day end */
  overnightAck: boolean;
  /** Coordinator-approved buffer after this existing booking; never authorizes a new solver placement. */
  approvedBufferAfterSlots?: number;
  /** A Sadran reservation (REQ §13.96): occupies the car's time but not its location. */
  locationNeutral?: boolean;
  /** Multi-day series this ride belongs to: pieces of one series on consecutive days are contiguous
   *  by construction and need no turnaround buffer between them (QB1). */
  seriesId?: string;
  kind: 'pinned' | 'acceptedProposal' | 'temporaryOwner';
}

export interface PolicyRuleConfig {
  type: string;
  weight: number;
  params: unknown;
}
export interface Policy {
  id: string;
  version: number;
  rules: PolicyRuleConfig[];
  /**
   * Car-choice mode (owner, 2026-09-14; docs/SOLVER.md §3.6/§3.6.2, REQUIREMENTS §13.84):
   * `'spread'` (default, absent = `'spread'`) ranks mileage balance above the best-fit
   * packing heuristic (`fragmentation`) in the car-choice key, spreading mileage across
   * cars; `'pack'` ranks packing above mileage, keeping whole cars free — mileage stays
   * as the tie-break just before `car.id`. Everything else in the key is unaffected.
   */
  carChoice?: 'pack' | 'spread';
}

export interface SolverStats {
  fairness: Record<string, { deficit: number }>;
  usualCarId: Record<string, string>;
}

export interface SolverConfig {
  /** default 30 (department_settings.turnaround_minutes) */
  bufferMinutes: number;
  detour: { maxMinutes: number; maxKm: number };
  beyondFlexMaxMinutes: number;
  defaultTravelMinutes: number;
  /** default 10 (department_settings.chauffeur_dwell_minutes) */
  chauffeurDwellMinutes: number;
  improvementBudget: number;
  perRequestBudget: number;
  externalHints: { cabMaxMinutes: number; rentalMinHours: number; ptMinScore: number };
  /**
   * Multi-stop rides (REQUIREMENTS §13.93, ORIGINS_PLAN §6.2): minutes added
   * per stop to a leg's route duration (`department_settings.stop_minutes`).
   * Optional; `resolveStopMinutes()` (`src/solver/travel.ts`) defaults it to 5.
   */
  stopMinutes?: number;
  /**
   * R7B2 (owner 2026-10-08): the `chauffeur` suggestion kind is hidden for the pilot. Absent/false = no
   * chauffeur suggestion is produced (so no card action, draft or auto-proposal); `true` brings it back.
   * Placement-time chauffeur rides (drop-off healing, `PLACED_CHAUFFEUR_*`) are unaffected.
   */
  chauffeurSuggestions?: boolean;
}

export interface SolverInput {
  week: { startMs: number; days: DayBounds[] };
  /** departments.home_destination_id */
  homeLocationId: string;
  cars: Car[];
  requests: Request[];
  fixedRides: FixedRide[];
  destinations: Record<string, Destination>;
  policy: Policy;
  stats: SolverStats;
  config: SolverConfig;
  /**
   * Known point-to-point travel figures not involving home (REQUIREMENTS
   * §13.93, ORIGINS_PLAN §4) — e.g. Google-routed distances between two
   * non-home destinations. Symmetric: a row matches either direction. Read
   * via `travelBetween()`, never indexed directly.
   */
  travel?: TravelEdge[];
  previousAssignments?: Pick<Assignment, 'servedRequestIds' | 'carId'>[];
  /** elapsed-time measurement only, never business logic; no Date.now()/new Date() inside the solver */
  now?: () => number;
}

export interface Assignment {
  rideId: string;
  carId: string;
  window: Window;
  /** where the *car* is at ride start / end (= rides.origin_id / destination_id); both home unless a relay leg */
  originId: string;
  destinationId: string;
  /** undefined for a chauffeur ride (REQUIREMENTS §13.88: nobody claims the driver role yet) */
  driverRequestId?: string;
  /**
   * The member who actually drives: the driver request's own `memberId`
   * unless that request's requester `canDrive === false`, in which case this
   * is the lexicographically-first id of its `drivingCompanionIds` (REQUIREMENTS
   * §13.88, owner 2026-09-16 — "a driving companion becomes the driver
   * automatically"). Set by the Sadran, not the solver, for chauffeur rides.
   */
  driverMemberId?: string;
  legs: AssignmentLeg[];
  servedRequestIds: string[];
  passengers: Passengers;
  luggageCount: number;
  /** signed, 0 if at preferred */
  shift: { departureMin: number; returnMin: number };
  /** The other leg of a relay pair — a solo (unpaired) relay leg is never placed as
   *  `relay` anymore (REQUIREMENTS §13.88/§13.89, rule made precise 2026-09-16): it
   *  becomes a standalone `chauffeur` placement instead (§3.6.1a), which has no
   *  partner and leaves this undefined. */
  pairedRideId?: string;
  /** Out-leg of a relay pair whose partner leaves X sooner than the buffer after this leg
   *  arrives (REQUIREMENTS §13.88, owner 2026-09-24: a short gap still pairs): the actual gap in
   *  minutes, persisted as `rides.turnaround_override_minutes` so the ride trigger accepts it.
   *  Undefined when the gap is at least the buffer. */
  turnaroundAfterMinutes?: number;
  /** set for a leg of a multi-day series (SOLVER §3.x); all legs of one series share this id and one carId */
  seriesId?: string;
  source: 'fixed' | 'solver';
  reasonCode: string;
  /** Hebrew */
  reason: string;
}

export interface Relocation {
  rideId: string;
  fromCarId: string;
  toCarId: string;
  window: Window;
}

export interface UnmetRequest {
  requestId: string;
  score: number;
  blockers: { carId: string; rideIds: string[] }[];
  /** ordered */
  suggestions: Suggestion[];
  reasonCode: string;
  reason: string;
}

interface SuggestionBase {
  requestId: string;
  reasonCode: string;
  reason: string;
  /** positive, lower is better, comparable only within one kind */
  cost: number;
  /** 0..1 */
  confidence: number;
}

export type SuggestionKind =
  | 'shiftWithinFlex'
  | 'merge'
  | 'shiftBeyondFlex'
  | 'splitLegs'
  | 'convertToRoundTrip'
  | 'chauffeur'
  | 'changeOrigin'
  | 'chainOneWay'
  | 'useAlternative'
  | 'externalHint'
  | 'deny';

export type Suggestion =
  | (SuggestionBase & {
      kind: 'shiftWithinFlex';
      carId: string;
      window: Window;
      shift: { departureMin: number; returnMin: number };
      relocations: Relocation[];
    })
  | (SuggestionBase & {
      kind: 'merge';
      hostRideId: string;
      guestRequestIds: string[];
      leg: LegSide;
      proposedDriverRequestId: string;
      window: Window;
      hostShift?: { departureMin: number; returnMin: number };
      detourMinutes: number;
      detourKm: number;
      /** REQUIREMENTS §13.95 (H1): the host ride's window before the merge (`window` is the new
       *  one — earlier start by `addedOutMinutes`, later end by `addedReturnMinutes`). */
      hostWindowBefore?: Window;
      addedOutMinutes?: number;
      addedReturnMinutes?: number;
      /**
       * Multi-stop rides (REQUIREMENTS §13.93, ORIGINS_PLAN §6.3): where the
       * guest boards the host's ride — the host's own origin in the
       * same-origin case, or one of the host's declared stops. Informational,
       * for the UI/proposal; never changes placement.
       */
      boardAtLocationId?: string;
    })
  | (SuggestionBase & {
      kind: 'shiftBeyondFlex';
      carId: string;
      window: Window;
      shift: { departureMin: number; returnMin: number };
      pairsWithRequestId?: string;
    })
  | (SuggestionBase & {
      kind: 'splitLegs';
      outbound: { hostRideId?: string; carMode: 'passenger' | 'relay'; departSlot: Slot; carId?: string };
      return: { hostRideId?: string; carMode: 'passenger' | 'relay'; arriveSlot: Slot; carId?: string };
    })
  | (SuggestionBase & {
      kind: 'convertToRoundTrip';
      carId: string;
      window: Window;
      returnSlot: Slot;
    })
  | (SuggestionBase & {
      kind: 'chauffeur';
      leg: 'out' | 'return';
      carId: string;
      window: Window;
      volunteerCandidateMemberIds: string[];
    })
  | (SuggestionBase & {
      /**
       * REQUIREMENTS §13.93, ORIGINS_PLAN §4: a car is free for this
       * request's whole window at another place Y (where that car already
       * is), so placing the request's origin at Y breaks nothing. SOLVER
       * §3.15 maps this to proposal type `origin`, payload `{ originId, carId }`
       * (shown to the Sadran only — never auto-applied).
       */
      kind: 'changeOrigin';
      carId: string;
      originId: string;
      window: Window;
    })
  | (SuggestionBase & {
      /**
       * REQUIREMENTS §13.105 a (QA run 5 R5Q1): another member's one-way ride ends at this unmet one-way
       * request's origin X and leaves the car standing there, so the request can follow on the same car
       * (`window` = the request's own length, starting at its stated departure or the earliest slot the
       * car is free again, <= `beyondFlexMaxMinutes` later; `shift` says how far that is). Shown to the
       * Sadran only, never automatic. SOLVER §3.15 maps this to proposal type `shift`, payload
       * `{ car_id: carId, depart_at }` (the requester consents when the time moves).
       */
      kind: 'chainOneWay';
      carId: string;
      window: Window;
      shift: { departureMin: number; returnMin: number };
      /** the ride the request follows, and the first request it serves (the other member) */
      afterRideId: string;
      afterRequestId?: string;
    })
  | (SuggestionBase & {
      /**
       * REQUIREMENTS §13.112 (a): the request is unmet but its plan B (a drop-off to the member's drop place) fits —
       * `carId` takes the member to the drop place at `departSlot` (the car leaves with them, arriving by `arriveBy`),
       * and, with a pickup, `returnCarId` (default `carId`) brings them home: `returnSlot` is when they are back
       * (pickup time + the drive). Nothing is placed; SOLVER §3.15 maps this to proposal type `alternative`,
       * payload `{ car_id, return_car_id?, depart_at, return_at? }` (Sadran-sent only, never automatic).
       */
      kind: 'useAlternative';
      carId: string;
      returnCarId?: string;
      departSlot: Slot;
      returnSlot?: Slot;
    })
  | (SuggestionBase & {
      kind: 'externalHint';
      hint: 'cab' | 'rental' | 'publicTransport';
    })
  | (SuggestionBase & { kind: 'deny' });

export interface MergeOpportunity {
  hostRideId: string;
  guestRideId: string;
  freedCarId: string;
  freedWindow: Window;
  detourMinutes: number;
  reason: string;
}

export interface SolverOutput {
  policyId: string;
  policyVersion: number;
  assignments: Assignment[];
  unmet: UnmetRequest[];
  mergeOpportunities: MergeOpportunity[];
  /** for the board's location badges */
  carsAway: { carId: string; locationId: string; window: Window }[];
  warnings: { code: string; message: string; requestId?: string }[];
  stats: {
    served: number;
    unmet: number;
    needsDriver: number;
    relocations: number;
    budgetExhausted: boolean;
    elapsedMs: number;
  };
}

/** Thrown by assertInvariants() when the computed output violates a hard constraint. */
export class SolverInvariantError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'SolverInvariantError';
  }
}

/** Thrown by a rule's validateParams() when policy params are malformed. reasonCode is looked up in reasons.ts. */
export class PolicyParamsError extends Error {
  constructor(public readonly reasonCode: string) {
    super(reasonCode);
    this.name = 'PolicyParamsError';
  }
}
