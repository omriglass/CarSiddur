import type { NormalizedRequest, NormalizedLeg } from './slots';
import type { CarTimeline } from './timeline';
import type { Window } from './types';
export interface Placement {
    window: Window;
    shift: {
        departureMin: number;
        returnMin: number;
    };
    /** total |shift| in minutes; part 1 of the car choice key (SOLVER §3.6) */
    cost: number;
}
/**
 * Best (minimal-shift) placement of `nr`'s single leg on `tl`, searching every
 * free gap whose location matches the leg's origin. `widenMinutes` extends
 * both flex bounds symmetrically (used for the beyondFlex search, SOLVER §3.11).
 */
export declare function bestPlacementWithinFlex(tl: CarTimeline, nr: NormalizedRequest, opts?: {
    widenMinutes?: number;
}): Placement | null;
/** Lower-level placement of an arbitrary leg (used by relay pairing / split legs to place one leg at a time). */
export declare function bestPlacementForLeg(tl: CarTimeline, nr: NormalizedRequest, leg: NormalizedLeg, widenMinutes?: number): Placement | null;
