import type { Car } from './types';

/** Soft tie-break only: feasibility and request score are never relaxed for a preference. */
export function carPreferenceRank(carId: string, preferredIds: readonly (string | undefined)[]): number {
  return preferredIds.reduce((rank, preferred) => rank + Number(!!preferred && preferred !== carId), 0);
}
export function carsByPreference(cars: readonly Car[], preferredCarId: string | undefined): Car[] {
  return [...cars].sort((a, b) => carPreferenceRank(a.id, [preferredCarId]) - carPreferenceRank(b.id, [preferredCarId])
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
