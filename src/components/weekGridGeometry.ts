/** Below this many minutes of raw (unsnapped) vertical pointer movement, treat a drag as a pure car change — no time shift at all. */
const TIME_SHIFT_DEAD_ZONE_MINUTES = 7.5;

export interface ClampedRideRect {
  top: string;
  height: string;
  /** The ride's real `startMinutes` is before the visible range — render the "↑ HH:MM" marker (UX_FLOWS §20). */
  clampedStart: boolean;
}

/** Percentage top/height for a ride within its car column's time axis, clamping to the visible range and flagging an earlier real start. Exported for unit tests. */
export function clampRideVertical(startMinutes: number, endMinutes: number, gridStart: number, gridEnd: number): ClampedRideRect {
  const total = gridEnd - gridStart;
  const top = ((Math.max(startMinutes, gridStart) - gridStart) / total) * 100;
  const height = ((Math.min(endMinutes, gridEnd) - Math.max(startMinutes, gridStart)) / total) * 100;
  return { top: `${top}%`, height: `${Math.max(height, 0.5)}%`, clampedStart: startMinutes < gridStart };
}

/** Physical-top-to-minutes mapping (dir-independent — vertical position is never mirrored by `dir`). Exported for unit tests. */
export function minutesFromClientY(rect: { top: number; height: number }, clientY: number, dayStartMinutes: number, dayEndMinutes: number): number {
  const ratio = rect.height === 0 ? 0 : (clientY - rect.top) / rect.height;
  const minutes = dayStartMinutes + ratio * (dayEndMinutes - dayStartMinutes);
  return Math.round(minutes / 15) * 15;
}

/** Snap a raw (unsnapped) minutes delta to 15 minutes, zeroing anything under half a slot (a car-only, i.e. purely horizontal, drag must not shift time at all). */
export function snapTimeShift(rawDeltaMinutes: number): number {
  if (Math.abs(rawDeltaMinutes) < TIME_SHIFT_DEAD_ZONE_MINUTES) return 0;
  return Math.round(rawDeltaMinutes / 15) * 15;
}
