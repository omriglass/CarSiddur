// REQ §13.112 (a)/(b): how the board states a request's fallback -- the member's plan B ("ב׳: הקפצה ל… עד … · איסוף …")
// or "אסתדר". Pure; the same plan text is used by the proposal texts (`proposalText.ts`) and the draft labels.
import { he, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";

import type { RequestAlternativeEmbed } from "../api";

export interface FallbackRequest {
  fallback?: string | null;
  alternative?: RequestAlternativeEmbed | null;
  trip_type: string;
  series_id?: string | null;
  served_by_alternative?: boolean | null;
}

/** An active fallback exists only on a round trip / one-way that is not a multi-day series (a stored plan B of a הקפצה stays dormant, REQ §13.97). */
export function hasActiveFallback(request: FallbackRequest): boolean {
  return (request.trip_type === "round_trip" || request.trip_type === "one_way") && !request.series_id && (request.fallback === "alternative" || request.fallback === "manage");
}

/** "הקפצה לצומת חריש עד 08:00, ואיסוף משם ב־19:00". */
export function alternativePlanText(alt: Pick<RequestAlternativeEmbed, "drop_place_text" | "arrive_by" | "pickup" | "pickup_at"> & {
  drop_place?: { name: string } | null; pickup_place?: { name: string } | null; pickup_place_text?: string | null;
}): string {
  const pickupPlace = alt.pickup_place?.name ?? alt.pickup_place_text ?? "";
  const pickupLine = alt.pickup && alt.pickup_at
    ? tv(pickupPlace ? "sadranProposal.alternativePickupFrom" : "sadranProposal.alternativePickup", { pickupTime: formatTime(new Date(alt.pickup_at)), pickupPlace })
    : "";
  return tv("sadranProposal.alternativePlan", {
    dropPlace: alt.drop_place?.name ?? alt.drop_place_text ?? "", dropTime: formatTime(new Date(alt.arrive_by)), pickupLine,
  });
}

/** The line on an unmet card: "אסתדר", or "ב׳: הקפצה ל… עד …"; `null` when the request has no active fallback. */
export function fallbackLine(request: FallbackRequest): string | null {
  if (!hasActiveFallback(request)) return null;
  if (request.fallback === "manage") return he.sadranPlanB.manage;
  return request.alternative ? tv("sadranPlanB.line", { plan: alternativePlanText(request.alternative) }) : null;
}
