import { isPastWeek } from "@/lib/pastWeek";

import type { Week } from "./api";

export { isPastWeek };

/** Past weeks only, newest first — the data behind `SiddurArchivePage`. */
export function pastWeeks<W extends Pick<Week, "week_start" | "phase">>(
  weeks: readonly W[],
  todayDateKey: string,
): W[] {
  return weeks.filter((w) => isPastWeek(w, todayDateKey)).sort((a, b) => (a.week_start < b.week_start ? 1 : -1));
}
