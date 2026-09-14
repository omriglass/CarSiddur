export interface PassengerCounts {
  adults: number;
  childSeats: number;
  boosters: number;
}

export type PassengerField = keyof PassengerCounts;

export const BOUNDS: Record<PassengerField, { min: number; max: number }> = {
  adults: { min: 1, max: 8 },
  childSeats: { min: 0, max: 8 },
  boosters: { min: 0, max: 8 },
};

/** Clamps a single field of `PassengerCounts` to its allowed range (adults ≥ 1, UX_FLOWS.md §3.4). */
export function clampPassengerField(field: PassengerField, value: number): number {
  const { min, max } = BOUNDS[field];
  return Math.min(Math.max(value, min), max);
}
