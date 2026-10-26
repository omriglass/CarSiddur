// REQ §13.154 (f): the member's calendar over the planning month — every event is one block on each Jerusalem day it
// touches, however long it is (an all-day event's end is the first instant of the day after its last).
import { datesFrom } from "@/components/dateFieldDates";
import { dateKey } from "@/lib/time";

import type { CalendarEvent } from "./types";

export interface MonthEventBlock {
  id: string;
  title: string;
  color?: string;
  /** ISO instants, for the day sheet's times. */
  start: string;
  end: string;
  allDay: boolean;
}

export function eventsByDay(events: readonly CalendarEvent[]): Map<string, MonthEventBlock[]> {
  const byDay = new Map<string, MonthEventBlock[]>();
  for (const event of events) {
    const first = dateKey(event.start);
    // The last instant inside the event decides its last day (an end at midnight belongs to the day before).
    const last = dateKey(Math.max(Date.parse(event.start), Date.parse(event.end) - 1));
    const span = Math.max(1, Math.round((Date.parse(`${last}T12:00:00Z`) - Date.parse(`${first}T12:00:00Z`)) / 86_400_000) + 1);
    for (const day of datesFrom(first, Math.min(span, 62))) {
      const list = byDay.get(day) ?? [];
      list.push({ id: event.id, title: event.title, color: event.color, start: event.start, end: event.end, allDay: event.allDay });
      byDay.set(day, list);
    }
  }
  return byDay;
}
