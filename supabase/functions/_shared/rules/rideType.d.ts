import type { Rule } from './types';
export interface RideTypeParams {
    /** keyed by `ride_types.code` — any string key is accepted; the set of codes is admin data, not fixed at compile time */
    weights: Record<string, number>;
    /** applied to a ride type absent from `weights` (e.g. a code added after this policy version was saved) */
    defaultWeight: number;
}
export declare const rideType: Rule<RideTypeParams>;
