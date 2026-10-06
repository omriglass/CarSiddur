import { formatTime } from "./time";

/** QB17: a span from local midnight to the end of a day (23:45+ or the next midnight) is a whole-day leg, not "00:00–00:00". */
export function isWholeDaySpan(departAt: string | null, returnAt: string | null): boolean {
  if (!departAt || !returnAt || formatTime(new Date(departAt)) !== "00:00") return false;
  const end = formatTime(new Date(returnAt));
  return end === "00:00" || end >= "23:45";
}

export type RideSpanKind = "all_day" | "departure_only" | "return_only" | "range";

/**
 * R5B11: how a ride's own start/end read on a card. A multi-day series leg is stored as 00:00-23:59 on its
 * middle days, `HH:MM-23:59` on the first and `00:00-HH:MM` on the last: middle = "all day", first = the
 * departure only, last = the return only - never a raw 00:00 / 23:59.
 */
export function rideSpanKind(startsAt: string, endsAt: string | null): RideSpanKind {
  if (!endsAt) return "range";
  const start = formatTime(new Date(startsAt));
  const end = formatTime(new Date(endsAt));
  const endsAtMidnight = end === "00:00" || end >= "23:45";
  if (start === "00:00" && endsAtMidnight) return "all_day";
  if (endsAtMidnight && start !== "00:00") return "departure_only";
  if (start === "00:00" && end !== "00:00") return "return_only";
  return "range";
}
