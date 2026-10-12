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
}

interface GooglePage<T> {
  items?: T[];
  nextPageToken?: string;
}

export interface GoogleCalendarInfo extends CalendarInfo {
  primary: boolean;
}

export interface GoogleCalendarSource extends CalendarSource {
  listCalendars(): Promise<GoogleCalendarInfo[]>;
}

/** An all-day `date` (`yyyy-MM-dd`) → the first instant of that Jerusalem day. */
function dayStartIso(date: string): string {
  return fromZonedTime(`${date}T00:00:00`, TZ).toISOString();
}

/** One Google event → a `CalendarEvent`; `null` for a cancelled occurrence or one without times. */
export function toCalendarEvent(event: GoogleEvent, calendarId: string): CalendarEvent | null {
  if (event.status === "cancelled" || !event.start || !event.end) return null;
  const title = event.summary ?? "";
  if (event.start.dateTime && event.end.dateTime) {
    return { id: event.id, calendarId, title, start: new Date(event.start.dateTime).toISOString(), end: new Date(event.end.dateTime).toISOString(), allDay: false };
  }
  if (event.start.date && event.end.date) {
    // Google's all-day `end.date` is already exclusive (the day after the last day).
    return { id: event.id, calendarId, title, start: dayStartIso(event.start.date), end: dayStartIso(event.end.date), allDay: true };
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

  return {
    async listCalendars() {
      const entries = await getPages<GoogleCalendarListEntry>("/users/me/calendarList", { maxResults: "250", fields: "items(id,summary,summaryOverride,primary),nextPageToken" }, "throw");
      return entries
        .map((entry) => ({ id: entry.id, name: entry.summaryOverride ?? entry.summary ?? entry.id, primary: entry.primary === true }))
        .sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    },
    async listEvents(calendarIds, fromIso, toIso) {
      const perCalendar = await Promise.all(
        calendarIds.map(async (calendarId) => {
          const events = await getPages<GoogleEvent>(
            `/calendars/${encodeURIComponent(calendarId)}/events`,
            { timeMin: fromIso, timeMax: toIso, singleEvents: "true", maxResults: "250", fields: "items(id,status,summary,start,end),nextPageToken" },
            "empty",
          );
          return events.map((event) => toCalendarEvent(event, calendarId)).filter((event): event is CalendarEvent => event !== null);
        }),
      );
      return perCalendar.flat();
    },
    disconnect() {
      revokeCalendarToken(accessToken);
    },
  };
}
