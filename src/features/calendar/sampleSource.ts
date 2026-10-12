// A fake `CalendarSource` for local testing of the calendar view without a Google client id (owner 2026-10-12).
// DEV BUILDS ONLY: `CalendarDialog` offers it under `import.meta.env.DEV`; a production build never shows it.
// Deterministic: the events of a range are a pure function of its Jerusalem days (a weekly pattern by weekday).
import { fromZonedTime } from "date-fns-tz";

import { he } from "@/i18n/he";
import { TZ, dateKey, weekdayIndex } from "@/lib/time";

import { addDaysToKey } from "../requests/myWeek/dayColumns";
import type { CalendarEvent, CalendarInfo, CalendarSource } from "./types";

export const SAMPLE_CALENDAR_IDS = ["sample-personal", "sample-work", "sample-family"] as const;
type SampleCalendarId = (typeof SAMPLE_CALENDAR_IDS)[number];

const CALENDAR_COLORS: Record<SampleCalendarId, string> = { "sample-personal": "#039be5", "sample-work": "#33b679", "sample-family": "#e67c73" };

type EventKey = keyof typeof he.calendar.sample.events;

interface Template {
  key: EventKey;
  /** 0 = Sunday .. 6 = Saturday (Jerusalem). */
  dow: number;
  calendar: SampleCalendarId;
  /** "HH:MM" Jerusalem; absent for an all-day event. */
  at?: string;
  minutes?: number;
  /** All-day events: how many days the event covers. */
  days?: number;
  /** Indexes into `he.calendar.sample.people`. */
  people?: number[];
  color?: string;
}

const TEMPLATES: Template[] = [
  { key: "standup", dow: 0, calendar: "sample-work", at: "09:00", minutes: 60, people: [0, 1] },
  { key: "planning", dow: 0, calendar: "sample-work", at: "09:30", minutes: 90, people: [0, 1, 2, 3, 4] }, // overlaps the stand-up
  { key: "lunch", dow: 0, calendar: "sample-personal", at: "12:30", minutes: 60 },
  { key: "pickup", dow: 0, calendar: "sample-family", at: "16:00", minutes: 45 },
  { key: "yoga", dow: 1, calendar: "sample-personal", at: "07:00", minutes: 60 },
  { key: "review", dow: 1, calendar: "sample-work", at: "10:00", minutes: 120, people: [2], color: "#8e24aa" }, // own color
  { key: "parents", dow: 1, calendar: "sample-family", at: "17:00", minutes: 60, people: [3] },
  { key: "dinner", dow: 1, calendar: "sample-family", at: "19:00", minutes: 120, people: [0, 1, 2] },
  { key: "holiday", dow: 2, calendar: "sample-family", days: 1 },
  { key: "standup", dow: 2, calendar: "sample-work", at: "09:00", minutes: 60, people: [0, 1] },
  { key: "workshop", dow: 2, calendar: "sample-work", at: "13:00", minutes: 150 },
  { key: "dentist", dow: 2, calendar: "sample-personal", at: "16:30", minutes: 45 },
  { key: "trip", dow: 3, calendar: "sample-work", days: 2 },
  { key: "standup", dow: 3, calendar: "sample-work", at: "09:00", minutes: 60, people: [0, 1] },
  { key: "lunch", dow: 3, calendar: "sample-personal", at: "12:30", minutes: 60 },
  { key: "movie", dow: 3, calendar: "sample-personal", at: "20:30", minutes: 255, people: [4] }, // crosses midnight
  { key: "standup", dow: 4, calendar: "sample-work", at: "09:00", minutes: 60, people: [0, 1] },
  { key: "lunch", dow: 4, calendar: "sample-personal", at: "13:00", minutes: 60 },
  { key: "brunch", dow: 5, calendar: "sample-family", at: "10:00", minutes: 120, people: [2, 3] },
  { key: "shabbat", dow: 5, calendar: "sample-family", at: "19:00", minutes: 150, people: [0, 1, 2, 3] },
  { key: "walk", dow: 6, calendar: "sample-personal", at: "08:00", minutes: 90 },
  { key: "visit", dow: 6, calendar: "sample-family", at: "17:00", minutes: 180, people: [1] },
];

const MINUTE_MS = 60_000;

function dayStartMs(key: string): number {
  return fromZonedTime(`${key}T00:00:00`, TZ).getTime();
}

function eventsOfDay(key: string): CalendarEvent[] {
  const dow = weekdayIndex(dayStartMs(key) + 12 * 60 * MINUTE_MS);
  const people = he.calendar.sample.people;
  return TEMPLATES.filter((template) => template.dow === dow).map((template) => {
    const copy = he.calendar.sample.events[template.key];
    const allDay = template.at === undefined;
    const start = allDay ? dayStartMs(key) : fromZonedTime(`${key}T${template.at}:00`, TZ).getTime();
    const end = allDay ? dayStartMs(addDaysToKey(key, template.days ?? 1)) : start + (template.minutes ?? 60) * MINUTE_MS;
    const event: CalendarEvent = {
      id: `${key}-${template.key}`,
      calendarId: template.calendar,
      title: copy.title,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      allDay,
      color: template.color ?? CALENDAR_COLORS[template.calendar],
    };
    if (copy.location) event.location = copy.location;
    if (copy.notes) event.description = copy.notes;
    if (template.people && template.people.length > 0) event.attendees = template.people.map((index) => people[index] ?? "");
    return event;
  });
}

export function createSampleCalendarSource(): CalendarSource {
  const names = he.calendar.sample.calendars;
  const calendars: CalendarInfo[] = [
    { id: "sample-personal", name: names.personal, color: CALENDAR_COLORS["sample-personal"] },
    { id: "sample-work", name: names.work, color: CALENDAR_COLORS["sample-work"] },
    { id: "sample-family", name: names.family, color: CALENDAR_COLORS["sample-family"] },
  ];
  return {
    listCalendars: () => Promise.resolve(calendars),
    listEvents(calendarIds, fromIso, toIso) {
      const from = Date.parse(fromIso);
      const to = Date.parse(toIso);
      if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return Promise.resolve([]);
      const events: CalendarEvent[] = [];
      // One day before the range too: an event can reach into it from the day before (overnight / multi-day).
      const last = dateKey(to - 1);
      for (let key = addDaysToKey(dateKey(from), -2), guard = 0; key <= last && guard < 60; key = addDaysToKey(key, 1), guard++) {
        for (const event of eventsOfDay(key)) {
          if (!calendarIds.includes(event.calendarId)) continue;
          if (Date.parse(event.start) < to && Date.parse(event.end) > from) events.push(event);
        }
      }
      return Promise.resolve(events);
    },
  };
}
