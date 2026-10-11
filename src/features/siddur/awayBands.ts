// Owner 2026-10-11: the members' siddur shows the same hatched "the car is at X" band as the Sadran board, so everyone sees
// that the car cannot be taken from home then — and that someone who is at X can. Source: `v_car_locations` (one row per
// ride that leaves a car away from its base, until the car's next ride; reservations never move a car).
import type { WeekGridBlock } from "@/components/WeekGrid";
import { dateKey, formatTime } from "@/lib/time";

export interface CarAwayRow {
  car_id: string | null;
  away_from: string | null;
  away_until: string | null;
  location_name: string | null;
}

function minutesOfDay(instant: string): number {
  const [h, m] = formatTime(new Date(instant)).split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** The away bands of `day` (`yyyy-MM-dd`, Asia/Jerusalem), clipped to the day; open-ended stays run to midnight. */
export function awayBandBlocks(rows: readonly CarAwayRow[], day: string, label: (place: string) => string): WeekGridBlock[] {
  return rows.flatMap((row, index) => {
    if (!row.car_id || !row.away_from) return [];
    const fromDay = dateKey(row.away_from);
    const untilDay = row.away_until ? dateKey(row.away_until) : null;
    if (fromDay > day || (untilDay !== null && untilDay < day)) return [];
    const startMinutes = fromDay < day ? 0 : minutesOfDay(row.away_from);
    const endMinutes = !row.away_until || (untilDay as string) > day ? 1440 : minutesOfDay(row.away_until);
    if (endMinutes <= startMinutes) return [];
    return [{ id: `away:${row.car_id}:${index}`, carId: row.car_id, startMinutes, endMinutes, kind: "away" as const, label: label(row.location_name ?? "") }];
  });
}
