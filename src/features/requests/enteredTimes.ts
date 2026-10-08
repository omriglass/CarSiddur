// REQ §13.110 (b) / UX_FLOWS §3.4a "Display of entered times": a request entered as
// "arrive by 09:30" / "leave there at 13:00" is shown that way on `/my` and the board's unmet
// card, next to the car times derived from it. Pure label building (no Hebrew literals).
import { tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";

import type { TimeAnchor } from "@/lib/enums";

export interface EnteredTimesSource {
  departAnchor?: TimeAnchor | null;
  arriveBy?: string | null;
  returnAnchor?: TimeAnchor | null;
  leaveDestAt?: string | null;
  /** The request's destination name ("יציאה מ<place>"). */
  destinationName: string;
  /** A הקפצה's return leg is the pickup ("איסוף מ<place>"). */
  isPickup?: boolean;
}

export interface EnteredTimeLabels {
  /** "להגיע עד 09:30" — only when the outbound was entered as arrive-by. */
  out: string | null;
  /** "יציאה מחיפה 13:00" / "איסוף מחיפה 13:00" — only when the return was entered as leave-there. */
  return: string | null;
}

export function enteredTimeLabels(source: EnteredTimesSource): EnteredTimeLabels {
  const out = source.departAnchor === "arrive" && source.arriveBy
    ? tv("requestSentence.enteredArriveBy", { time: formatTime(new Date(source.arriveBy)) })
    : null;
  const ret = source.returnAnchor === "leave" && source.leaveDestAt
    ? tv(source.isPickup ? "requestSentence.enteredPickupFrom" : "requestSentence.enteredLeaveFrom", {
        place: source.destinationName,
        time: formatTime(new Date(source.leaveDestAt)),
      })
    : null;
  return { out, return: ret };
}
