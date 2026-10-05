import type { DestinationValue } from "@/components/DestinationCombobox";
import type { RouteStop } from "@/lib/routeStops";

/**
 * Bridges the request form's own stop chips (`DestinationValue[]`, `StopsField.tsx`) and the
 * `submit_request`/prefill shapes (REQUIREMENTS §13.93 "Multi-stop rides",
 * docs/ORIGINS_PLAN_2026-10.md §6.1).
 */

/** One leg's already-ordered `RouteStop[]` (template suggestion prefill) as the form's own picker values. */
export function routeStopsToDestinationValues(stops: readonly RouteStop[], leg: "out" | "return"): DestinationValue[] {
  return stops
    .filter((s) => s.leg === leg)
    .sort((a, b) => a.position - b.position)
    .map((s) => (s.placeId ? { presetId: s.placeId, name: s.name } : { freeText: s.placeText ?? s.name }));
}

export interface StopPayloadItem {
  leg: "out" | "return";
  place_id?: string;
  place_text?: string;
}

/** `submit_request` payload `stops` entries for one leg, in chip (route) order (`mapper.ts`). */
export function destinationValuesToStopPayload(values: readonly DestinationValue[], leg: "out" | "return"): StopPayloadItem[] {
  return values.map((v) => ("presetId" in v ? { leg, place_id: v.presetId } : { leg, place_text: v.freeText }));
}
