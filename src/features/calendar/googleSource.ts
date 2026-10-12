// A `CalendarSource` over the Google Calendar REST API (owner 2026-10-12, experimental). Called from the member's
// browser with an access token the Google Identity Services token client handed over (`googleIdentity.ts`); the token
// lives in this closure only and is never stored. Read-only (`calendar.readonly`).
import { fromZonedTime } from "date-fns-tz";

import { TZ } from "@/lib/time";

import { revokeCalendarToken } from "./googleIdentity";
import type { CalendarEvent, CalendarInfo, CalendarSource } from "./types";

const API = "https://www.googleapis.com/calendar/v3";

/** The token expired or was revoked — the caller drops the source and offers "connect" again. */
export class CalendarAuthError extends Error {
  constructor() {
    super("calendar_auth");
    this.name = "CalendarAuthError";
  }
}

interface GoogleCalendarListEntry {
  id: string;
  summary?: string;
  summaryOverride?: string;
  primary?: boolean;
  backgroundColor?: string;
}

interface GoogleEventTime {
  dateTime?: string;
  date?: string;
}

export interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  location?: string;
  description?: string;
  colorId?: string;
  attendees?: { displayName?: string; email?: string; self?: boolean; resource?: boolean }[];
}

interface GooglePage<T> {
  items?: T[];
  nextPageToken?: string;
}

export interface GoogleCalendarInfo extends CalendarInfo {
  primary: boolean;
}

interface GoogleColorsResponse {
  event?: Record<string, { background?: string }>;
}

export interface GoogleCalendarSource extends CalendarSource {
  listCalendars(): Promise<GoogleCalendarInfo[]>;
}

/** An all-day `date` (`yyyy-MM-dd`) → the first instant of that Jerusalem day. */
function dayStartIso(date: string): string {
  return fromZonedTime(`${date}T00:00:00`, TZ).toISOString();
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

/** Google may return HTML in a description: keep only the first non-empty line of its text. */
export function firstDescriptionLine(raw: string): string | undefined {
  const text = raw
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (entity) => ENTITIES[entity] ?? entity);
  const line = text.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0);
  return line || undefined;
}

export interface GoogleEventColors {
  /** The calendar's own `backgroundColor`. */
  calendar?: string;
  /** Google's event palette: `colorId` → hex. */
  palette?: Readonly<Record<string, string>>;
}

/** One Google event → a `CalendarEvent`; `null` for a cancelled occurrence or one without times. */
export function toCalendarEvent(event: GoogleEvent, calendarId: string, colors: GoogleEventColors = {}): CalendarEvent | null {
  if (event.status === "cancelled" || !event.start || !event.end) return null;
  const title = event.summary ?? "";
  const extras: Partial<CalendarEvent> = {};
  const location = event.location?.trim();
  if (location) extras.location = location;
  const attendees = (event.attendees ?? [])
    .filter((attendee) => !attendee.self && !attendee.resource)
    .map((attendee) => attendee.displayName?.trim() || attendee.email?.trim() || "")
    .filter((name) => name.length > 0);
  if (attendees.length > 0) extras.attendees = attendees;
  const description = event.description ? firstDescriptionLine(event.description) : undefined;
  if (description) extras.description = description;
  const color = (event.colorId ? colors.palette?.[event.colorId] : undefined) ?? colors.calendar;
  if (color) extras.color = color;
  if (event.start.dateTime && event.end.dateTime) {
    return { id: event.id, calendarId, title, start: new Date(event.start.dateTime).toISOString(), end: new Date(event.end.dateTime).toISOString(), allDay: false, ...extras };
  }
  if (event.start.date && event.end.date) {
    // Google's all-day `end.date` is already exclusive (the day after the last day).
    return { id: event.id, calendarId, title, start: dayStartIso(event.start.date), end: dayStartIso(event.end.date), allDay: true, ...extras };
  }
  return null;
}

type Fetch = typeof fetch;

export function createGoogleCalendarSource(accessToken: string, fetchImpl: Fetch = (...args) => fetch(...args)): GoogleCalendarSource {
  async function getPages<T>(path: string, params: Record<string, string>, onMissing: "throw" | "empty"): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ ...params, ...(pageToken ? { pageToken } : {}) });
      const response = await fetchImpl(`${API}${path}?${query.toString()}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (response.status === 401) throw new CalendarAuthError();
      // A remembered calendar the signed-in Google account cannot read (another account, unsubscribed) is skipped.
      if ((response.status === 403 || response.status === 404) && onMissing === "empty") return [];
      if (!response.ok) throw new Error(`calendar_http_${response.status}`);
      const page = (await response.json()) as GooglePage<T>;
      items.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return items;
  }

  // Google's event palette, fetched once per source; a failure just means events keep their calendar's color.
  let palettePromise: Promise<Record<string, string>> | undefined;
  function eventPalette(): Promise<Record<string, string>> {
    palettePromise ??= (async () => {
      try {
        const response = await fetchImpl(`${API}/colors`, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!response.ok) return {};
        const body = (await response.json()) as GoogleColorsResponse;
        const palette: Record<string, string> = {};
        for (const [id, entry] of Object.entries(body.event ?? {})) if (entry.background) palette[id] = entry.background;
        return palette;
      } catch {
        return {};
      }
    })();
    return palettePromise;
  }
  // A calendar's own color, by id (cached): events are read without listing calendars first after a reconnect.
  const calendarColorPromises = new Map<string, Promise<string | undefined>>();
  function calendarColor(calendarId: string): Promise<string | undefined> {
    let promise = calendarColorPromises.get(calendarId);
    if (!promise) {
      promise = (async () => {
        try {
          const query = new URLSearchParams({ fields: "backgroundColor" });
          const response = await fetchImpl(`${API}/users/me/calendarList/${encodeURIComponent(calendarId)}?${query.toString()}`, { headers: { Authorization: `Bearer ${accessToken}` } });
          if (!response.ok) return undefined;
          return ((await response.json()) as GoogleCalendarListEntry).backgroundColor || undefined;
        } catch {
          return undefined;
        }
      })();
      calendarColorPromises.set(calendarId, promise);
    }
    return promise;
  }

  return {
    async listCalendars() {
      const entries = await getPages<GoogleCalendarListEntry>("/users/me/calendarList", { maxResults: "250", fields: "items(id,summary,summaryOverride,primary,backgroundColor),nextPageToken" }, "throw");
      return entries
        .map((entry) => {
          if (entry.backgroundColor) calendarColorPromises.set(entry.id, Promise.resolve(entry.backgroundColor));
          return { id: entry.id, name: entry.summaryOverride ?? entry.summary ?? entry.id, primary: entry.primary === true, ...(entry.backgroundColor ? { color: entry.backgroundColor } : {}) };
        })
        .sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    },
    async listEvents(calendarIds, fromIso, toIso) {
      const palette = await eventPalette();
      const perCalendar = await Promise.all(
        calendarIds.map(async (calendarId) => {
          const color = await calendarColor(calendarId);
          const events = await getPages<GoogleEvent>(
            `/calendars/${encodeURIComponent(calendarId)}/events`,
            { timeMin: fromIso, timeMax: toIso, singleEvents: "true", maxResults: "250", fields: "items(id,status,summary,start,end,location,description,attendees(displayName,email,self,resource),colorId),nextPageToken" },
            "empty",
          );
          return events.map((event) => toCalendarEvent(event, calendarId, { calendar: color, palette })).filter((event): event is CalendarEvent => event !== null);
        }),
      );
      return perCalendar.flat();
    },
    disconnect() {
      revokeCalendarToken(accessToken);
    },
  };
}
