/**
 * Free-window computation for one car (quick-request-from-empty-slot, UX_FLOWS.md §18):
 * given a car's rides, maintenance blocks and away-from-home windows, returns the gaps where
 * a new round-trip "keep" request could start. Mirrors `try_auto_approve()`'s own eligibility
 * rule (`supabase/migrations/20260907093200_quick_request_preferred_car.sql`: the car must be
 * free for `[depart, return + turnaround)` and at home at depart time) so the client can
 * pre-validate before submitting instead of only finding out from the RPC afterward.
 *
 * Pure TypeScript — no React/Supabase/`Date.now()` (the same purity discipline `src/solver`
 * enforces, CLAUDE.md hard rule 5, even though this module lives outside `src/solver`);
 * callers always pass `now` explicitly, which is what makes this unit-testable without mocking
 * the clock.
 */

export interface BusyInterval {
  /** epoch ms */
  start: number;
  /** epoch ms */
  end: number;
}

export interface CarFreeWindow {
  carId: string;
  /** epoch ms, already clipped to `now` (rounded up to the next 15 minutes) */
  start: number;
  /** epoch ms */
  end: number;
}

export interface ComputeCarFreeWindowsInput {
  carId: string;
  /** This car's own non-cancelled rides whose window overlaps `[rangeStart, rangeEnd]`. */
  rides: readonly { startsAt: string; endsAt: string }[];
  /** Maintenance blocks for this car overlapping the range. */
  maintenanceBlocks?: readonly { startsAt: string; endsAt: string }[];
  /**
   * Windows where the car is away from home (`v_car_locations`-shaped: a relay leg leaves it
   * elsewhere until the matching relay-back ride, or indefinitely if none is placed yet) —
   * fully blocks a "keep" request, which needs the car at home at depart time.
   */
  awayWindows?: readonly { awayFrom: string; awayUntil: string | null }[];
  /** `department_settings.turnaround_minutes` — required gap after a ride (and before the next). */
  turnaroundMinutes: number;
  /** epoch ms, the display range to compute gaps within (e.g. one day, 05:00–24:00). */
  rangeStart: number;
  rangeEnd: number;
  /** epoch ms "now" — windows are clipped so nothing in the past is ever offered. */
  now: number;
}

const QUARTER_HOUR_MS = 15 * 60_000;

/**
 * Rounds an epoch-ms instant up to the next 15-minute mark. Safe to do in plain UTC epoch
 * arithmetic here (unlike wall-clock day/hour math elsewhere, CLAUDE.md hard rule 6) because
 * Asia/Jerusalem's UTC offset is always a whole number of hours, never a fraction of 15
 * minutes, so quarter-hour boundaries coincide in both UTC and local time.
 */
export function roundUpToQuarterHour(epochMs: number): number {
  return Math.ceil(epochMs / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
}

function mergeIntervals(intervals: readonly BusyInterval[]): BusyInterval[] {
  if (intervals.length === 0) return [];
  const [first, ...rest] = [...intervals].sort((a, b) => a.start - b.start);
  const merged: BusyInterval[] = [{ ...(first as BusyInterval) }];
  for (const cur of rest) {
    const last = merged[merged.length - 1] as BusyInterval;
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/**
 * Gaps where a new "keep" round trip could start on this one car, each already shrunk by the
 * turnaround buffer before the next blocking interval (matching `try_auto_approve()`'s own
 * overlap check, which extends both the existing ride and the candidate window by the buffer
 * — symmetric enough that reserving it once, on the trailing edge of every merged busy
 * interval, reproduces the same result) and clipped so nothing before `now` is ever offered.
 */
export function computeCarFreeWindows(input: ComputeCarFreeWindowsInput): CarFreeWindow[] {
  const turnaroundMs = Math.max(input.turnaroundMinutes, 0) * 60_000;

  const busy: BusyInterval[] = [
    ...input.rides.map((r) => ({ start: Date.parse(r.startsAt), end: Date.parse(r.endsAt) + turnaroundMs })),
    ...(input.maintenanceBlocks ?? []).map((b) => ({ start: Date.parse(b.startsAt), end: Date.parse(b.endsAt) })),
    ...(input.awayWindows ?? []).map((w) => ({
      start: Date.parse(w.awayFrom),
      // No known return yet (no matching relay-back ride placed) -> blocks through the end
      // of whatever range the caller asked about, not just until awayFrom.
      end: w.awayUntil !== null ? Date.parse(w.awayUntil) : Infinity,
    })),
  ].filter((b) => b.end > input.rangeStart && b.start < input.rangeEnd);

  const merged = mergeIntervals(busy);
  const earliestStart = Math.max(input.rangeStart, roundUpToQuarterHour(input.now));

  const windows: CarFreeWindow[] = [];
  let cursor = input.rangeStart;
  for (const interval of merged) {
    const gapEnd = interval.start - turnaroundMs;
    if (gapEnd > cursor) {
      windows.push({ carId: input.carId, start: cursor, end: gapEnd });
    }
    cursor = Math.max(cursor, interval.end);
  }
  if (input.rangeEnd > cursor) {
    windows.push({ carId: input.carId, start: cursor, end: input.rangeEnd });
  }

  return windows
    .map((w) => ({ ...w, start: Math.max(w.start, earliestStart) }))
    .filter((w) => w.end > w.start);
}

/** Is `[start, end)` fully free for `carId` per the already-computed `windows`? */
export function isSlotFree(windows: readonly CarFreeWindow[], carId: string, start: number, end: number): boolean {
  return windows.some((w) => w.carId === carId && w.start <= start && end <= w.end);
}

/** The soonest free window for `carId` starting at or after `after` (epoch ms), if any. */
export function nextFreeWindowForCar(
  windows: readonly CarFreeWindow[],
  carId: string,
  after: number,
): CarFreeWindow | null {
  const candidates = windows.filter((w) => w.carId === carId && w.end > after).sort((a, b) => a.start - b.start);
  return candidates[0] ?? null;
}

/**
 * The first car (in the given `windows` order — callers pass them in whatever order they want
 * "first" to mean, e.g. by car name) that is free starting exactly at `now` rounded up to the
 * next quarter hour — i.e. free *right now* ("לוקח/ת רכב עכשיו"), not merely free later today.
 */
export function firstCarFreeNow(windows: readonly CarFreeWindow[], now: number): CarFreeWindow | null {
  const nowRounded = roundUpToQuarterHour(now);
  return windows.find((w) => w.start === nowRounded) ?? null;
}
