// The calendars the member picked to show, remembered on this device (owner 2026-10-12: localStorage is enough for now;
// later a profile setting). Only calendar ids — never a token, never an event.
const STORAGE_KEY = "calendar.selected.v1";

export function readSelectedCalendarIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function writeSelectedCalendarIds(ids: readonly string[]): void {
  try {
    if (ids.length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // A convenience only; storage may be denied in private browsing.
  }
}
