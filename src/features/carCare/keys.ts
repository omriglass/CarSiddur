/**
 * `carCare` has no queries of its own yet — the responsible-person/admin
 * history view on `/cars/:carId` (REQUIREMENTS §6.6, owned by another
 * agent's `features/cars`) is the natural reader of `car_issues`/
 * `car_care_events`. Exported here anyway (CLAUDE.md folder map: every
 * feature gets a `keys.ts`) so that history screen can invalidate the same
 * keys this feature's mutations use below, once it lands.
 */
export const carCareKeys = {
  issues: (carId: string | undefined) => ["carCare", "issues", carId] as const,
  events: (carId: string | undefined) => ["carCare", "events", carId] as const,
};
