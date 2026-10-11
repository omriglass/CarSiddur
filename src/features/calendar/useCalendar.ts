import { useContext } from "react";

import { CalendarContext, type CalendarContextValue } from "./calendarContextValue";

/** Without a mounted provider this is "no source", so screens can read it unconditionally. */
export function useCalendar(): CalendarContextValue {
  return useContext(CalendarContext);
}
