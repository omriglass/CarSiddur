// Holds the member's current calendar source IN MEMORY ONLY (owner 2026-10-11, groundwork — nothing sets a source
// yet). Deliberately no localStorage / sessionStorage / IndexedDB and no server call: a calendar token must never
// outlive the tab, and the server must never see the member's calendar. Reloading the page forgets the source.
import { useMemo, useState, type ReactNode } from "react";

import { CalendarContext } from "./calendarContextValue";
import type { CalendarSource } from "./types";

export function CalendarProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<CalendarSource | null>(null);
  const [selectedCalendarIds, setSelectedCalendarIds] = useState<readonly string[]>([]);
  const value = useMemo(() => ({ source, setSource, selectedCalendarIds, setSelectedCalendarIds }), [source, selectedCalendarIds]);
  return <CalendarContext.Provider value={value}>{children}</CalendarContext.Provider>;
}
