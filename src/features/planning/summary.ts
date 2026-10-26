import { he, tv } from "@/i18n/he";

import type { PlanningReservation } from "./api";

export function placeOf(r: PlanningReservation): string {
  return r.destinationName ?? "";
}

/** "עומרי ל־חיפה" — the at-a-glance line (REQ §13.154 c). */
export function reservationSummary(r: PlanningReservation): string {
  return tv("planning.summaryLine", { name: r.requesterName || he.planning.unnamed, place: placeOf(r) });
}
