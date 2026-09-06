// supabase/functions/_shared/tz.ts
//
// Minimal Asia/Jerusalem wall-clock <-> epoch-ms conversion for building
// solver inputs inside Edge Functions (CLAUDE.md hard rule 6: "the solver
// never does wall-clock arithmetic — it gets epoch ms and per-day slot
// bounds"; this file does the DST-aware conversion the caller needs before
// handing the solver plain numbers). Deno ships full ICU/Intl, so this needs
// no date library.

const TZ = 'Asia/Jerusalem';
export const SLOT_MS = 15 * 60 * 1000;
const DAY_SLOTS = 96;

function offsetMsAt(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - utcMs;
}

/** Epoch ms of local midnight (00:00 Asia/Jerusalem) on the given `YYYY-MM-DD` date, DST-aware. */
export function zonedMidnightMs(dateStr: string, timeZone: string = TZ): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  // Two passes converge even across a DST boundary (offset changes by at most an hour).
  for (let i = 0; i < 2; i++) {
    const offset = offsetMsAt(guess, timeZone);
    guess = Date.UTC(y, m - 1, d, 0, 0, 0) - offset;
  }
  return guess;
}

/** Epoch ms for a `HH:MM[:SS]` local wall-clock time on the given local date. */
export function zonedTimeMs(dateStr: string, hhmmss: string, timeZone: string = TZ): number {
  const [hh, mm, ss] = hhmmss.split(':').map(Number);
  const midnight = zonedMidnightMs(dateStr, timeZone);
  return midnight + (hh * 60 + (mm ?? 0)) * 60_000 + (ss ?? 0) * 1000;
}

export function toSlotFloor(ms: number, weekStartMs: number): number {
  return Math.floor((ms - weekStartMs) / SLOT_MS);
}

export function toSlotCeil(ms: number, weekStartMs: number): number {
  return Math.ceil((ms - weekStartMs) / SLOT_MS);
}

export function minutesToSlots(minutes: number): number {
  return Math.round(minutes / 15);
}

export interface DayBounds {
  dayIndex: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  startSlot: number;
  endSlot: number;
  dayEndSlot: number;
}

/**
 * Builds the solver's `week.days` (SOLVER.md §2) for a Sunday `weekStart`
 * date, given the department's `day_end_time` ('HH:MM:SS'). Each day is a
 * fixed 96-slot (24h) span from `weekStartMs`; day-length DST anomalies
 * (SOLVER.md §11, Vitest-only fixtures) are not modelled here since this
 * function only needs to support the freed-slot flow, not a full `solve()`.
 */
export function buildWeekDays(weekStartMs: number, dayEndTime: string): DayBounds[] {
  const dayEndSlotOffset = minutesToSlots(
    Number(dayEndTime.split(':')[0]) * 60 + Number(dayEndTime.split(':')[1] ?? 0),
  );
  const days: DayBounds[] = [];
  for (let i = 0; i < 7; i++) {
    const start = i * DAY_SLOTS;
    days.push({
      dayIndex: i as DayBounds['dayIndex'],
      startSlot: start,
      endSlot: start + DAY_SLOTS,
      dayEndSlot: start + Math.min(dayEndSlotOffset, DAY_SLOTS - 1),
    });
  }
  return days;
}

export { TZ };
