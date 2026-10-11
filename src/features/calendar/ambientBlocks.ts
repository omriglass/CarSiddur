// Calendar events -> the faint background blocks of the "my rides" week grid (`WeekGridAmbientBlock`, one column per
// day, the column id is the `yyyy-MM-dd` day key). Pure; Asia/Jerusalem via `src/lib/time.ts` / `myWeek/dayColumns`.
//
// All-day events are SKIPPED (decision 2026-10-11): they are holidays, birthdays and "out of office" markers that would
// shade a whole column and bury the rides; the grid is about hours. Revisit if the owner wants a full-day band.
import type { WeekGridAmbientBlock } from "@/components/WeekGrid";

import { daySegments, weekDayKeys } from "../requests/myWeek/dayColumns";
import type { CalendarEvent } from "./types";

export function eventsToAmbientBlocks(events: readonly CalendarEvent[], weekStart: string): WeekGridAmbientBlock[] {
  const dayKeys = weekDayKeys(weekStart);
  const blocks: WeekGridAmbientBlock[] = [];
  for (const event of events) {
    if (event.allDay) continue;
    // An event spanning midnight is cut per day (ids get a `~n` suffix after the first); a zero-length event is
    // given the segment helper's default hour so it stays visible.
    daySegments(event.start, event.end, dayKeys).forEach((segment, index) => {
      blocks.push({
        id: index === 0 ? `${event.calendarId}:${event.id}` : `${event.calendarId}:${event.id}~${index}`,
        carId: segment.dayKey,
        startMinutes: segment.startMinutes,
        endMinutes: segment.endMinutes,
        label: event.title,
      });
    });
  }
  return blocks.sort((a, b) => a.carId.localeCompare(b.carId) || a.startMinutes - b.startMinutes || a.id.localeCompare(b.id));
}
