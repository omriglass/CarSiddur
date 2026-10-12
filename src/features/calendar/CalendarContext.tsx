// Holds the member's current calendar source IN MEMORY ONLY (owner 2026-10-11). Deliberately no storage and no server
// call for the source: a calendar token must never outlive the tab, and the server must never see the member's calendar.
// Reloading the page forgets the source. Only the picked calendar IDS are remembered on this device (owner 2026-10-12,
// `selectedCalendars.ts`), so one tap reconnects to the same calendars.
import { useMemo, useState, type ReactNode } from "react";

import { CalendarContext } from "./calendarContextValue";
import { readDisplayPrefs, writeDisplayPrefs, type CalendarDisplayPrefs } from "./displayPrefs";
import { readSelectedCalendarIds, writeSelectedCalendarIds } from "./selectedCalendars";
import type { CalendarSource } from "./types";

export function CalendarProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<CalendarSource | null>(null);
  const [selectedCalendarIds, setSelectedState] = useState<readonly string[]>(readSelectedCalendarIds);
  const [displayPrefs, setDisplayState] = useState<CalendarDisplayPrefs>(readDisplayPrefs);
  const value = useMemo(() => {
    function setSelectedCalendarIds(ids: readonly string[]) {
      setSelectedState(ids);
      writeSelectedCalendarIds(ids);
    }
    function setDisplayPrefs(prefs: CalendarDisplayPrefs) {
      setDisplayState(prefs);
      writeDisplayPrefs(prefs);
    }
    return { source, setSource, selectedCalendarIds, setSelectedCalendarIds, displayPrefs, setDisplayPrefs };
  }, [source, selectedCalendarIds, displayPrefs]);
  return <CalendarContext.Provider value={value}>{children}</CalendarContext.Provider>;
}
