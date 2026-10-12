// Calendar events -> the faint background blocks of the "my rides" week grid (`WeekGridAmbientBlock`, one column per
// day, the column id is the `yyyy-MM-dd` day key). Pure; Asia/Jerusalem via `src/lib/time.ts` / `myWeek/dayColumns`.
//
// All-day events (holidays, birthdays, "out of office") are drawn as a thin band at the top of each day they cover
// (owner 2026-10-12, `allDay: true`), so they never shade the hours the rides live in. The extra text lines follow the
// member's display preferences (`displayPrefs.ts`); the title is always the block's `label`.
import type { WeekGridAmbientBlock } from "@/components/WeekGrid";
import { formatMinutes } from "@/components/timeField15Format";
import { tv } from "@/i18n/he";
import { dateKey } from "@/lib/time";

import { assignLanes } from "../requests/myWeek/assignLanes";
import { addDaysToKey, daySegments, weekDayKeys } from "../requests/myWeek/dayColumns";
import { DEFAULT_DISPLAY_PREFS, type CalendarDisplayPrefs } from "./displayPrefs";
import type { CalendarEvent } from "./types";

const MAX_NAMES = 3;

function participantsLine(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMES).join(", ");
  return names.length > MAX_NAMES ? `${shown} ${tv("calendar.participantsMore", { count: String(names.length - MAX_NAMES) })}` : shown;
}

function extraLines(event: CalendarEvent, prefs: CalendarDisplayPrefs, hours: string | null): string[] {
  const lines: string[] = [];
  if (prefs.hours && hours) lines.push(hours);
  if (prefs.location && event.location) lines.push(event.location);
  if (prefs.participants && event.attendees && event.attendees.length > 0) lines.push(participantsLine(event.attendees));
  if (prefs.notes && event.description) lines.push(event.description);
  return lines;
}

export function eventsToAmbientBlocks(
  events: readonly CalendarEvent[],
  weekStart: string,
  prefs: CalendarDisplayPrefs = DEFAULT_DISPLAY_PREFS,
): WeekGridAmbientBlock[] {
  const dayKeys = weekDayKeys(weekStart);
  const blocks: WeekGridAmbientBlock[] = [];
  const idOf = (event: CalendarEvent, index: number) => (index === 0 ? `${event.calendarId}:${event.id}` : `${event.calendarId}:${event.id}~${index}`);
  for (const event of events) {
    // The calendar's own color only when the member chose it ("צבעי היומן"); otherwise the app's sky tint.
    const color = prefs.useCalendarColors && event.color ? { color: event.color } : {};
    if (event.allDay) {
      // `end` is the first instant of the day after the last covered day.
      const first = dateKey(Date.parse(event.start));
      const last = dateKey(Date.parse(event.end) - 1);
      const lines = extraLines(event, prefs, null);
      let index = 0;
      for (let key = first; key <= last && index < 16; key = addDaysToKey(key, 1), index++) {
        if (!dayKeys.includes(key)) continue;
        blocks.push({ id: idOf(event, index), carId: key, startMinutes: 0, endMinutes: 0, label: event.title, allDay: true, ...(lines.length > 0 ? { lines } : {}), ...color });
      }
      continue;
    }
    // An event spanning midnight is cut per day (ids get a `~n` suffix after the first); a zero-length event is
    // given the segment helper's default hour so it stays visible.
    daySegments(event.start, event.end, dayKeys).forEach((segment, index) => {
      const lines = extraLines(event, prefs, `${formatMinutes(segment.startMinutes)}–${formatMinutes(Math.min(segment.endMinutes, 1440))}`);
      blocks.push({
        id: idOf(event, index),
        carId: segment.dayKey,
        startMinutes: segment.startMinutes,
        endMinutes: segment.endMinutes,
        label: event.title,
        ...(lines.length > 0 ? { lines } : {}),
        ...color,
      });
    });
  }
  // Overlapping timed events sit side by side, like the member's own items (owner 2026-10-12).
  const lanes = assignLanes(blocks.filter((block) => !block.allDay));
  return blocks
    .map((block) => {
      const lane = lanes.get(block.id);
      return lane && lane.laneCount > 1 ? { ...block, lane: lane.lane, laneCount: lane.laneCount } : block;
    })
    .sort((a, b) => a.carId.localeCompare(b.carId) || Number(!!b.allDay) - Number(!!a.allDay) || a.startMinutes - b.startMinutes || a.id.localeCompare(b.id));
}
