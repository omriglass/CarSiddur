// REQ item 246 (LT1): labels of the stop-hours UI (StopHours.tsx, StopsSheet.tsx).
import { he, tv } from "@/i18n/he";

import { minutesToTime } from "../../duration";

/** "HH:MM" of a minute of the day (wrapped into the day). */
export const clock = (minutes: number) => minutesToTime(((minutes % 1440) + 1440) % 1440);

/** "45 דק׳", "שעה", "שעתיים ו־5 דק׳", "6 שעות" — Hebrew from he.request.stopHoursDur*. */
export function durationLabel(minutes: number): string {
  if (minutes < 60) return tv("request.stopHoursDurMinutes", { minutes: String(minutes) });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const h = hours === 1 ? he.request.stopHoursDurHour : hours === 2 ? he.request.stopHoursDurTwoHours : tv("request.stopHoursDurHours", { hours: String(hours) });
  return rest ? tv("request.stopHoursDurJoin", { hours: h, minutes: String(rest) }) : h;
}
