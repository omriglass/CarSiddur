// Holds the member's current calendar source (owner 2026-10-11). No server call for it: the server must never see the
// member's calendar. The Google token is remembered in this browser until it expires (owner 2026-10-22,
// `storedToken.ts`, restored by `useGoogleCalendar`), so a reload no longer forgets the calendar; dropping the source
// (disconnect, or Google rejecting the token) forgets it. The picked calendar IDS are remembered on this device too
// (owner 2026-10-12, `selectedCalendars.ts`).
import { useMemo, useState, type ReactNode } from "react";

import { CalendarContext } from "./calendarContextValue";
import { readDisplayPrefs, writeDisplayPrefs, type CalendarDisplayPrefs } from "./displayPrefs";
import { readSelectedCalendarIds, writeSelectedCalendarIds } from "./selectedCalendars";
import { clearStoredCalendarToken } from "./storedToken";
import type { CalendarSource } from "./types";

export function CalendarProvider({ children }: { children: ReactNode }) {
  const [source, setSourceState] = useState<CalendarSource | null>(null);
  const [selectedCalendarIds, setSelectedState] = useState<readonly string[]>(readSelectedCalendarIds);
  const [displayPrefs, setDisplayState] = useState<CalendarDisplayPrefs>(readDisplayPrefs);
  const value = useMemo(() => {
    function setSelectedCalendarIds(ids: readonly string[]) {
      setSelectedState(ids);
      writeSelectedCalendarIds(ids);
    }
    function setSource(next: CalendarSource | null) {
      if (!next) clearStoredCalendarToken();
      setSourceState(next);
    }
    function setDisplayPrefs(prefs: CalendarDisplayPrefs) {
      setDisplayState(prefs);
      writeDisplayPrefs(prefs);
    }
    return { source, setSource, selectedCalendarIds, setSelectedCalendarIds, displayPrefs, setDisplayPrefs };
  }, [source, selectedCalendarIds, displayPrefs]);
  return <CalendarContext.Provider value={value}>{children}</CalendarContext.Provider>;
}
