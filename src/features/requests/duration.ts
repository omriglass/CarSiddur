/** Quick duration chips stay within the selected day, capped at 23:59. */
export const QUICK_REQUEST_DURATION_HOURS = [1, 2, 3, 4] as const;
export type QuickRequestDurationHours = (typeof QUICK_REQUEST_DURATION_HOURS)[number];
export type QuickRequestDuration = QuickRequestDurationHours | "custom";

const MINUTES_PER_DAY = 24 * 60;

function timeToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function minutesToTime(value: number): string {
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

/** `start` + duration, capped at the last minute of that day. */
export function endTimeForDuration(start: string, hours: QuickRequestDurationHours): DurationEnd {
  const totalMinutes = timeToMinutes(start) + hours * 60;
  return { time: minutesToTime(Math.min(totalMinutes, MINUTES_PER_DAY - 1)), nextDay: false };
}
