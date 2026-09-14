import { todayInJerusalem } from "./dateFieldDates";

/** True when `date` (`yyyy-MM-dd`) is today in Asia/Jerusalem. */
export function isToday(date: string, today = todayInJerusalem()): boolean {
  return date === today;
}
