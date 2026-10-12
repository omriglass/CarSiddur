// REQ §13.128: a member's own ride stays editable from the ride sheet until its day (Asia/Jerusalem) is over.
import { dateKey } from "@/lib/time";

/** True while `now` is on the ride's Jerusalem calendar day or before it (a started ride of today still counts). */
export function isRideDayEditable(startsAt: string | null | undefined, now: Date): boolean {
  if (!startsAt) return false;
  return dateKey(startsAt) >= dateKey(now);
}
