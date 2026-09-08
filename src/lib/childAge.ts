/**
 * Product rule: a named child becomes an ordinary passenger at age eight.
 * With only a birth year recorded, this uses the calendar year of the ride.
 */
export const ADULT_PASSENGER_AGE = 8;

export function ageFromBirthYear(birthYear: number | null | undefined, referenceYear = new Date().getFullYear()): number | null {
  if (!birthYear || !Number.isInteger(birthYear)) return null;
  return Math.max(0, referenceYear - birthYear);
}

export function isAdultPassenger(birthYear: number | null | undefined, referenceYear?: number): boolean {
  const age = ageFromBirthYear(birthYear, referenceYear);
  return age !== null && age >= ADULT_PASSENGER_AGE;
}
