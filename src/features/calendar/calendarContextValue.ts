import { createContext } from "react";

import type { CalendarSource } from "./types";

export interface CalendarContextValue {
  /** `null` until a later version connects one. */
  source: CalendarSource | null;
  setSource: (source: CalendarSource | null) => void;
  /** The calendars the member picked to show. */
  selectedCalendarIds: readonly string[];
  setSelectedCalendarIds: (ids: readonly string[]) => void;
}

export const NONE: CalendarContextValue = {
  source: null,
  setSource: () => {},
  selectedCalendarIds: [],
  setSelectedCalendarIds: () => {},
};

export const CalendarContext = createContext<CalendarContextValue>(NONE);
