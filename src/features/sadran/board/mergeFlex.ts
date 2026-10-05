// REQ §13.101 (QU5): the merge popup shows each party's flexibility. Pure formatting helper.
import { he, tv } from "@/i18n/he";
import { parseFlexInterval } from "@/features/solverBridge/buildSolverInput";

import type { WeekRequestRow } from "../api";

type FlexFields = Pick<WeekRequestRow, "flex_depart_early" | "flex_depart_late" | "flex_return_early" | "flex_return_late" | "return_at">;

/** One direction's flexibility: "כל היום", "ללא גמישות" or "15 דק׳ קודם / 30 דק׳ אחר כך". */
export function flexRangeLabel(early: string | null | undefined, late: string | null | undefined): string {
  const a = parseFlexInterval(early);
  const b = parseFlexInterval(late);
  if (a === "day" || b === "day") return he.flex.anyTime;
  if (a === 0 && b === 0) return he.mergedRide.flexNone;
  return tv("mergedRide.flexRange", { early: String(a), late: String(b) });
}

/** The departure line, plus the return line when the request has a return. */
export function requestFlexLines(request: FlexFields): { depart: string; return: string | null } {
  return {
    depart: flexRangeLabel(request.flex_depart_early, request.flex_depart_late),
    return: request.return_at ? flexRangeLabel(request.flex_return_early, request.flex_return_late) : null,
  };
}
