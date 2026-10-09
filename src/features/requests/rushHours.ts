// REQ §13.113 / UX_FLOWS §3.4a "Rush hours in the derived line": form-side only. A drive that falls
// (partly) inside a department rush-hour window takes `percent` % longer there. The solver, ride
// lengths and `route_minutes_preview` never use this; only the two conversions in `timeAnchors.ts`
// ("arrive by" -> departure, "leave there at" -> return) and plan B's "leave at" -> arrive-by do.
//
// Exact overlap rule (no stepping): inside a window of p % one minute of clock time covers only
// 1/(1+p/100) of a base driving minute; outside every window 1:1. A drive is walked window by
// window (backward from an arrival, forward from a departure) until all its base minutes are
// covered. All values are minutes of the day; a drive never wraps past the day's bounds.
import { timeToMinutes } from "./duration";

export interface RushWindow {
  /** minute of the day, inclusive start */
  startMinutes: number;
  /** minute of the day, exclusive end */
  endMinutes: number;
  /** extra drive time inside the window, in percent (> 0) */
  percent: number;
}

/** The windows that apply on one day; empty = no rush hours (Friday, Saturday, 0 % windows). */
export type RushWindows = readonly RushWindow[];

/** The `department_settings.rush_*` columns the form reads. */
export interface RushSettings {
  rush_morning_start: string;
  rush_morning_end: string;
  rush_morning_percent: number;
  rush_afternoon_start: string;
  rush_afternoon_end: string;
  rush_afternoon_percent: number;
}

/** Sunday = 0 ... Saturday = 6 of a "YYYY-MM-DD" key (a calendar date has no zone). */
export function dayOfWeekOfKey(dayKey: string): number {
  const [y = 0, m = 1, d = 1] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Rush hours exist Sunday-Thursday only. */
export function isRushDay(dayKey: string): boolean {
  return dayOfWeekOfKey(dayKey) <= 4;
}

/** The windows (sorted, 0 % and empty windows dropped) that apply on `dayKey`. */
export function rushWindowsForDay(settings: RushSettings | null | undefined, dayKey: string | undefined): RushWindows {
  if (!settings || !dayKey || !isRushDay(dayKey)) return [];
  // A settings row from before the rush columns (or a partial mock) simply has no rush hours.
  if (typeof settings.rush_morning_start !== "string" || typeof settings.rush_afternoon_start !== "string") return [];
  const windows: RushWindow[] = [
    { startMinutes: timeToMinutes(settings.rush_morning_start.slice(0, 5)), endMinutes: timeToMinutes(settings.rush_morning_end.slice(0, 5)), percent: settings.rush_morning_percent },
    { startMinutes: timeToMinutes(settings.rush_afternoon_start.slice(0, 5)), endMinutes: timeToMinutes(settings.rush_afternoon_end.slice(0, 5)), percent: settings.rush_afternoon_percent },
  ];
  return windows.filter((w) => w.percent > 0 && w.endMinutes > w.startMinutes).sort((a, b) => a.startMinutes - b.startMinutes);
}

/** Clock minutes needed to cover `baseMinutes` of driving that START at `startMinute`. */
export function stretchedMinutesFrom(startMinute: number, baseMinutes: number, windows: RushWindows): number {
  let t = startMinute;
  let remaining = baseMinutes;
  for (let guard = 0; remaining > 1e-9 && guard < 64; guard += 1) {
    const inside = windows.find((w) => t >= w.startMinutes && t < w.endMinutes);
    if (inside) {
      const factor = 1 + inside.percent / 100;
      const capacity = (inside.endMinutes - t) / factor;
      if (remaining <= capacity) return t + remaining * factor - startMinute;
      remaining -= capacity;
      t = inside.endMinutes;
    } else {
      const next = windows.find((w) => w.startMinutes > t);
      if (!next || remaining <= next.startMinutes - t) return t + remaining - startMinute;
      remaining -= next.startMinutes - t;
      t = next.startMinutes;
    }
  }
  return t - startMinute;
}

/** Clock minutes needed to cover `baseMinutes` of driving that END at `endMinute`. */
export function stretchedMinutesUntil(endMinute: number, baseMinutes: number, windows: RushWindows): number {
  let t = endMinute;
  let remaining = baseMinutes;
  for (let guard = 0; remaining > 1e-9 && guard < 64; guard += 1) {
    const inside = windows.find((w) => t > w.startMinutes && t <= w.endMinutes);
    if (inside) {
      const factor = 1 + inside.percent / 100;
      const capacity = (t - inside.startMinutes) / factor;
      if (remaining <= capacity) return endMinute - (t - remaining * factor);
      remaining -= capacity;
      t = inside.startMinutes;
    } else {
      const previous = [...windows].reverse().find((w) => w.endMinutes <= t);
      if (!previous || remaining <= t - previous.endMinutes) return endMinute - (t - remaining);
      remaining -= t - previous.endMinutes;
      t = previous.endMinutes;
    }
  }
  return endMinute - t;
}
