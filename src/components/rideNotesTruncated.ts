/** Marks a ride block's notes (`RideNotes`); `data-truncated` is set on it while its text does not fit (owner 2026-10-22). */
export const RIDE_NOTES_ATTR = "data-ride-notes";
export const RIDE_NOTES_TRUNCATED_ATTR = "data-truncated";

/** True when the ride block `rideEl` has notes cut off by its height — `WeekGrid` reads it on tap. */
export function rideNotesTruncated(rideEl: Element | null | undefined): boolean {
  return !!rideEl?.querySelector(`[${RIDE_NOTES_ATTR}][${RIDE_NOTES_TRUNCATED_ATTR}]`);
}
