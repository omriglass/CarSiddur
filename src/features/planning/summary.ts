import { he, tv } from "@/i18n/he";

import type { PlanningReservation } from "./api";

export function placeOf(r: PlanningReservation): string {
  return r.destinationName ?? "";
}

/** "עומרי ל־חיפה" — the at-a-glance line (REQ §13.154 c). */
export function reservationSummary(r: PlanningReservation): string {
  return tv("planning.summaryLine", { name: r.requesterName || he.planning.unnamed, place: placeOf(r) });
}

const COUNT_KEYS = {
  reservations: ["planning.countReservations", "countReservationsOne"],
  rides: ["planning.countRides", "countRidesOne"],
  requests: ["planning.countRequests", "countRequestsOne"],
} as const;

/** "3 טיוטות בקשה" / "טיוטת בקשה אחת" — a day's count with the Hebrew singular for one (R15B3). */
export function countLabel(kind: keyof typeof COUNT_KEYS, n: number): string {
  const [plural, one] = COUNT_KEYS[kind];
  return n === 1 ? he.planning[one] : tv(plural, { n: String(n) });
}
