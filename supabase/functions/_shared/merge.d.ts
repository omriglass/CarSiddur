import type { NormalizedRequest } from './slots';
import type { CarTimeline } from './timeline';
import type { Assignment, Car, Destination, LegSide, Passengers, SolverConfig, Window } from './types';
export interface HostRide {
    rideId: string;
    carId: string;
    window: Window;
    driverRequestId: string;
    legSide: LegSide;
    destinationId: string;
    passengers: Passengers;
    luggageCount: number;
    guestCount: number;
    isFixed: boolean;
    isTemporary: boolean;
}
export declare function buildHostRides(assignments: Assignment[], cars: Map<string, Car>): HostRide[];
export interface MergeCandidate {
    hostRideId: string;
    carId: string;
    window: Window;
    hostShift?: {
        departureMin: number;
        returnMin: number;
    };
    detourMinutes: number;
    detourKm: number;
    cost: number;
    confidence: number;
    proposedDriverRequestId: string;
}
export interface MergeSearchParams {
    guest: NormalizedRequest;
    leg: LegSide;
    hosts: HostRide[];
    destinations: Record<string, Destination>;
    config: SolverConfig;
    cars: Map<string, Car>;
    /** driver's own NormalizedRequest and timeline, for host-shift search (keyed by host rideId) */
    hostDriverRequests: Map<string, NormalizedRequest>;
    hostTimelines: Map<string, CarTimeline>;
}
export declare function findMergeHosts(params: MergeSearchParams): MergeCandidate[];
