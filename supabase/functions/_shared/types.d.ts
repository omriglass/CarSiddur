export type Slot = number;
export interface Window {
    start: Slot;
    end: Slot;
}
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
export interface Destination {
    id: string;
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
export interface Request {
    id: string;
    memberId: string;
    departmentId: string;
    destinationId: string;
    rideType: string;
    tripShape: TripShape;
    /** required when tripShape !== 'round_trip' */
    oneWayCarMode?: 'relay' | 'passenger';
    /** epoch ms, 15-min aligned; absent for one_way_from */
    departureMs?: number;
    /** epoch ms, 15-min aligned; absent for one_way_to */
    returnMs?: number;
    flexDeparture: Flexibility;
    flexReturn: Flexibility;
    passengers: Passengers;
    coRiderMemberIds: string[];
    luggage: boolean;
    /** round trips only */
    needsCarAtDestination: boolean;
    submittedAtMs: number;
    isLate: boolean;
    manualBoost?: {
        value: number;
        reason: string;
    };
    preferredCarId?: string;
}
export interface Car {
    id: string;
    name: string;
    type: 'shared' | 'temporary';
    ownerMemberId?: string;
    seatConfigs: Passengers[];
    features: string[];
    luggageCapacity: number;
    maintenance: Window[];
    /** where the car is at week start; default = home */
    startLocationId?: string;
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
}
export interface SolverStats {
    fairness: Record<string, {
        deficit: number;
    }>;
    usualCarId: Record<string, string>;
}
export interface SolverConfig {
    /** default 30 (department_settings.turnaround_minutes) */
    bufferMinutes: number;
    detour: {
        maxMinutes: number;
        maxKm: number;
    };
    beyondFlexMaxMinutes: number;
    defaultTravelMinutes: number;
    /** default 10 (department_settings.chauffeur_dwell_minutes) */
    chauffeurDwellMinutes: number;
    improvementBudget: number;
    perRequestBudget: number;
    externalHints: {
        cabMaxMinutes: number;
        rentalMinHours: number;
        ptMinScore: number;
    };
}
export interface SolverInput {
    week: {
        startMs: number;
        days: DayBounds[];
    };
    /** departments.home_destination_id */
    homeLocationId: string;
    cars: Car[];
    requests: Request[];
    fixedRides: FixedRide[];
    destinations: Record<string, Destination>;
    policy: Policy;
    stats: SolverStats;
    config: SolverConfig;
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
    /** undefined for chauffeur rides */
    driverRequestId?: string;
    /** set by the Sadran for chauffeur rides; the solver leaves it undefined */
    driverMemberId?: string;
    legs: AssignmentLeg[];
    servedRequestIds: string[];
    passengers: Passengers;
    luggageCount: number;
    /** signed, 0 if at preferred */
    shift: {
        departureMin: number;
        returnMin: number;
    };
    /** the other leg of a relay pair */
    pairedRideId?: string;
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
    blockers: {
        carId: string;
        rideIds: string[];
    }[];
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
export type SuggestionKind = 'shiftWithinFlex' | 'merge' | 'shiftBeyondFlex' | 'splitLegs' | 'convertToRoundTrip' | 'chauffeur' | 'externalHint' | 'deny';
export type Suggestion = (SuggestionBase & {
    kind: 'shiftWithinFlex';
    carId: string;
    window: Window;
    shift: {
        departureMin: number;
        returnMin: number;
    };
    relocations: Relocation[];
}) | (SuggestionBase & {
    kind: 'merge';
    hostRideId: string;
    guestRequestIds: string[];
    leg: LegSide;
    proposedDriverRequestId: string;
    window: Window;
    hostShift?: {
        departureMin: number;
        returnMin: number;
    };
    detourMinutes: number;
    detourKm: number;
}) | (SuggestionBase & {
    kind: 'shiftBeyondFlex';
    carId: string;
    window: Window;
    shift: {
        departureMin: number;
        returnMin: number;
    };
    pairsWithRequestId?: string;
}) | (SuggestionBase & {
    kind: 'splitLegs';
    outbound: {
        hostRideId?: string;
        carMode: 'passenger' | 'relay';
        departSlot: Slot;
        carId?: string;
    };
    return: {
        hostRideId?: string;
        carMode: 'passenger' | 'relay';
        arriveSlot: Slot;
        carId?: string;
    };
}) | (SuggestionBase & {
    kind: 'convertToRoundTrip';
    carId: string;
    window: Window;
    returnSlot: Slot;
}) | (SuggestionBase & {
    kind: 'chauffeur';
    leg: 'out' | 'return';
    carId: string;
    window: Window;
    volunteerCandidateMemberIds: string[];
}) | (SuggestionBase & {
    kind: 'externalHint';
    hint: 'cab' | 'rental' | 'publicTransport';
}) | (SuggestionBase & {
    kind: 'deny';
});
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
    carsAway: {
        carId: string;
        locationId: string;
        window: Window;
    }[];
    warnings: {
        code: string;
        message: string;
        requestId?: string;
    }[];
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
export declare class SolverInvariantError extends Error {
    readonly code: string;
    constructor(message: string, code: string);
}
/** Thrown by a rule's validateParams() when policy params are malformed. reasonCode is looked up in reasons.ts. */
export declare class PolicyParamsError extends Error {
    readonly reasonCode: string;
    constructor(reasonCode: string);
}
export {};
