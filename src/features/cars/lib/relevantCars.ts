/** How long before a ride starts its car already counts as "relevant" (the driver walks to it with the code ready). */
export const RELEVANT_BEFORE_MINUTES = 30;

interface RideLike {
  car_id: string | null;
  status: string | null;
  starts_at: string | null;
  ends_at: string | null;
  /** REQ §13.176: my own part of someone else's ride; absent = the whole ride. */
  my_part?: { starts_at: string; ends_at: string };
}

/**
 * MC1 (REQ item 218): the cars of the rides I am on right now — driver or passenger — from
 * `RELEVANT_BEFORE_MINUTES` before my part starts until it ends. Published rides only (confirmed / flagged),
 * so an unpublished plan never shows a car. Order: the ride that started first; each car once.
 */
export function relevantCarIds(rides: readonly RideLike[], now: Date, excludeCarIds: ReadonlySet<string> = new Set()): string[] {
  const at = now.getTime();
  const hits: { carId: string; start: number }[] = [];
  for (const ride of rides) {
    if (!ride.car_id || (ride.status !== "confirmed" && ride.status !== "flagged")) continue;
    const startIso = ride.my_part?.starts_at ?? ride.starts_at;
    const endIso = ride.my_part?.ends_at ?? ride.ends_at;
    if (!startIso || !endIso) continue;
    const start = Date.parse(startIso);
    const end = Date.parse(endIso);
    if (at >= start - RELEVANT_BEFORE_MINUTES * 60_000 && at < end) hits.push({ carId: ride.car_id, start });
  }
  hits.sort((a, b) => a.start - b.start || a.carId.localeCompare(b.carId));
  const ids: string[] = [];
  for (const hit of hits) if (!ids.includes(hit.carId) && !excludeCarIds.has(hit.carId)) ids.push(hit.carId);
  return ids;
}

/** The code to type at the car: the replacement car's code while the car is replaced. */
export function activeCarCode(car: { access_code?: string | null; is_replaced?: boolean; replacement_code?: string | null }): string | null {
  return (car.is_replaced ? car.replacement_code : car.access_code) ?? null;
}
