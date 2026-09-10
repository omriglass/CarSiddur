/**
 * Quick requests default to a two-hour gap between the prefilled depart/return times
 * (UX_FLOWS.md §18); afterwards the user edits `departTime`/`returnTime` directly
 * (the same `TimeField15` pair the weekly form uses) and `shiftReturnByDepartureDelta`
 * keeps the gap constant, capped at the last minute of the day.
 */
export const QUICK_REQUEST_DURATION_HOURS = 2;
export type QuickRequestDurationHours = 1 | 2 | 3 | 4;

const MINUTES_PER_DAY = 24 * 60;

export function timeToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function minutesToTime(value: number): string {
  const h = Math.floor(value / 60);
  const m = value % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export interface DurationEnd {
  /** "HH:MM" */
  time: string;
  /** Always false: quick requests end within the selected day. */
  nextDay: boolean;
}

/**
 * `start` + duration, capped at the last minute of that day. `hours` is typed as a plain
 * `number` (not `QuickRequestDurationHours`) so `../carNow.ts`'s 1–12-hour car-now duration
 * select can reuse it too, without widening the quick variant's own 1–4-hour default.
 */
export function endTimeForDuration(start: string, hours: number): DurationEnd {
  const totalMinutes = timeToMinutes(start) + hours * 60;
  return { time: minutesToTime(Math.min(totalMinutes, MINUTES_PER_DAY - 1)), nextDay: false };
}

/**
 * When the departure time changes, shifts the return time by the same delta so the gap
 * between them is preserved (RequestForm, item 2). Clamped to the day's last minute
 * (23:59) and floored at its first (00:00); does nothing when there is no return time to
 * shift (e.g. a one-way-to request with no return field shown).
 */
export function shiftReturnByDepartureDelta(
  previousDepartTime: string,
  nextDepartTime: string,
  currentReturnTime: string | undefined,
): string | undefined {
  if (!currentReturnTime) return currentReturnTime;
  const delta = timeToMinutes(nextDepartTime) - timeToMinutes(previousDepartTime);
  const shifted = timeToMinutes(currentReturnTime) + delta;
  return minutesToTime(Math.min(Math.max(shifted, 0), MINUTES_PER_DAY - 1));
}
