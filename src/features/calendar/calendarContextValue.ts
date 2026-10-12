import { createContext } from "react";

import { DEFAULT_DISPLAY_PREFS, type CalendarDisplayPrefs } from "./displayPrefs";
import type { CalendarSource } from "./types";

export interface CalendarContextValue {
  /** `null` until the member connects one (experimental; `useGoogleCalendar`). */
  source: CalendarSource | null;
  setSource: (source: CalendarSource | null) => void;
  /** The calendars the member picked to show; remembered on this device (`selectedCalendars.ts`). */
  selectedCalendarIds: readonly string[];
  setSelectedCalendarIds: (ids: readonly string[]) => void;
  /** Which event fields / colors the blocks show; remembered on this device (`displayPrefs.ts`). */
  displayPrefs: CalendarDisplayPrefs;
  setDisplayPrefs: (prefs: CalendarDisplayPrefs) => void;
}

export const NONE: CalendarContextValue = {
  source: null,
  setSource: () => {},
  selectedCalendarIds: [],
  setSelectedCalendarIds: () => {},
  displayPrefs: DEFAULT_DISPLAY_PREFS,
  setDisplayPrefs: () => {},
};

export const CalendarContext = createContext<CalendarContextValue>(NONE);
