import type { Car } from './types';
/** Soft tie-break only: feasibility and request score are never relaxed for a preference. */
export declare function carPreferenceRank(carId: string, preferredIds: readonly (string | undefined)[]): number;
export declare function carsByPreference(cars: readonly Car[], preferredCarId: string | undefined): Car[];
