import { formatTime } from "./time";

/** QB17: a span from local midnight to the end of a day (23:45+ or the next midnight) is a whole-day leg, not "00:00–00:00". */
export function isWholeDaySpan(departAt: string | null, returnAt: string | null): boolean {
  if (!departAt || !returnAt || formatTime(new Date(departAt)) !== "00:00") return false;
  const end = formatTime(new Date(returnAt));
  return end === "00:00" || end >= "23:45";
}
