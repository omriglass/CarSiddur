// REQ §13.110 (b): the ordered points of a request leg for `route_minutes_preview` — outbound
// is origin, out stops..., destination; the return is destination, return stops..., origin.
import type { DestinationValue } from "@/components/DestinationCombobox";

import type { RoutePreviewPoint } from "./api";

export function destinationValueToPoint(value: DestinationValue | null | undefined): RoutePreviewPoint {
  if (!value) return { place_id: null, place_text: null };
  if ("presetId" in value) return { place_id: value.presetId, place_text: null };
  return { place_id: null, place_text: value.freeText.trim() || null };
}

interface RouteValues {
  origin: DestinationValue;
  destination: DestinationValue;
  outStops: readonly DestinationValue[];
  returnStops: readonly DestinationValue[];
}

export function outboundRoutePoints(values: RouteValues): RoutePreviewPoint[] {
  return [values.origin, ...values.outStops, values.destination].map(destinationValueToPoint);
}

export function returnRoutePoints(values: RouteValues): RoutePreviewPoint[] {
  return [values.destination, ...values.returnStops, values.origin].map(destinationValueToPoint);
}

/** A route needs a real destination before the preview is worth asking for. */
export function hasDestination(value: DestinationValue | null | undefined): boolean {
  if (!value) return false;
  return "presetId" in value ? !!value.presetId : value.freeText.trim() !== "";
}
