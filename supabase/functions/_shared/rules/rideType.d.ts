import type { Rule } from './types';
export interface RideTypeParams {
    weights: Record<string, number>;
}
export declare const rideType: Rule<RideTypeParams>;
