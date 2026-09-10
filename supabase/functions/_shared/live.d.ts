import type { CarTimeline } from './timeline';
import type { Assignment, Car, Destination, Policy, Request, SolverConfig, SolverInput, SolverStats, Window } from './types';
export interface FreedSlotInput {
    car: Car;
    timeline: CarTimeline;
    freedWindow: Window;
    freedLocationId: string;
    candidates: Request[];
    destinations: Record<string, Destination>;
    policy: Policy;
    stats: SolverStats;
    config: SolverConfig;
    week: SolverInput['week'];
    homeLocationId: string;
}
export interface FreedSlotCandidate {
    requestId: string;
    window: Window;
    shift: {
        departureMin: number;
        returnMin: number;
    };
    score: number;
    reason: string;
}
/**
 * One-way requests are never freed-slot candidates (REQUIREMENTS §13.64) —
 * they need a partner, host or driver. Multi-day series legs are excluded
 * too (SOLVER §3.x): they are immovable and placed all-or-nothing across
 * every leg's own day, never into a single freed slot.
 */
export declare function matchFreedSlot(input: FreedSlotInput): FreedSlotCandidate[];
export interface AutoApproveInput {
    request: Request;
    cars: Car[];
    timelines: Record<string, CarTimeline>;
    config: SolverConfig;
    stats: SolverStats;
    week: SolverInput['week'];
    homeLocationId: string;
}
/**
 * Places a round-trip request only at its preferred time on a shared car free
 * and at home; null otherwise. One-way requests always return null. Multi-day
 * series legs always return null too — SQL's `try_auto_approve_series`
 * handles them, since all-or-nothing placement across every leg's day needs
 * the whole-series view the live/freed-slot helpers deliberately don't have.
 */
export declare function tryAutoApprove(input: AutoApproveInput): Assignment | null;
