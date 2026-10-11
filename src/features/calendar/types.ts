// Calendar groundwork (owner 2026-10-11) — NOT connected yet. Later versions will let a member show their own Google
// calendars faintly behind the "my rides" week view. Everything here is browser-only: a `CalendarSource` reads the
// events in the member's browser, nothing is stored on the server, and no token is ever persisted (see
// `CalendarContext.tsx`). No provider (Google or otherwise) exists in this change.

export interface CalendarInfo {
  id: string;
  name: string;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  /** Shown faintly on the block, as the member wrote it. */
  title: string;
  /** ISO instants. For an `allDay` event they are the first instant of its first day and of the day after its last. */
  start: string;
  end: string;
  allDay: boolean;
}

/**
 * Where calendar events come from. An implementation lives in the browser (e.g. a signed-in Google client) and keeps its
 * credentials in memory only. `listEvents` returns events overlapping `[fromIso, toIso)` for the given calendars.
 */
export interface CalendarSource {
  listCalendars(): Promise<CalendarInfo[]>;
  listEvents(calendarIds: readonly string[], fromIso: string, toIso: string): Promise<CalendarEvent[]>;
}
