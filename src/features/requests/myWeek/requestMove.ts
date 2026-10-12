// Dragging / resizing one of my requests on the "my rides" week view (owner 2026-10-12): the same `submit_request` edit
// the form would send after only its times were changed. Pure. The "how it was entered" anchors ("להגיע עד 15:30",
// "יציאה מ… 13:00") are deliberately NOT sent: `submit_request` then keeps them and the `requests_shift_anchors`
// trigger moves them by the same amount as the times. Seat counts are sent as stored (no `set_request_children` call
// follows, so nothing is re-added) and companions / guests are left out (kept as they are).
import { datesOfWeek } from "@/components/dateFieldDates";
import { formatMinutes } from "@/components/timeField15Format";

import type { RequestEditRow, SubmitRequestPayload } from "../api";
import { editRowToFormValues } from "../editRowValues";
import { toSubmitRequestPayload } from "../mapper";

export interface RequestMove {
  /** The day the request lands on (`yyyy-MM-dd`, a day of `weekStart`'s week). */
  day: string;
  /** New out / return time in minutes after midnight; `null` keeps the stored one. */
  departMinutes: number | null;
  returnMinutes: number | null;
}

/** The latest return the form can express on the same day (it has no "24:00"). */
const LAST_MINUTE = 23 * 60 + 59;

export function movedRequestPayload(row: RequestEditRow, weekStart: string, move: RequestMove): SubmitRequestPayload {
  const base = editRowToFormValues(row, weekStart, [], [], 0, 0);
  const dates = datesOfWeek(weekStart);
  const values = {
    ...base,
    day: move.day,
    returnDay: move.day,
    dayIndex: Math.max(dates.indexOf(move.day), 0),
    departTime: move.departMinutes != null ? formatMinutes(move.departMinutes) : base.departTime,
    returnTime: move.returnMinutes != null ? formatMinutes(Math.min(move.returnMinutes, LAST_MINUTE)) : base.returnTime,
    adults: row.adults,
    childSeats: row.childSeats,
  };
  return toSubmitRequestPayload(values, {
    requestId: row.id,
    expectedVersion: row.version,
    planB: true,
    storedFlex: { departEarly: row.flexDepartEarly, departLate: row.flexDepartLate, returnEarly: row.flexReturnEarly, returnLate: row.flexReturnLate },
  });
}
