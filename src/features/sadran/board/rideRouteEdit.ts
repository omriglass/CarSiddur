// REQ §13.94 (G8): the ride sheet's "מסלול" section. A ride that serves a member's request is
// edited through a `shift` proposal (draftable like any proposal) whose payload may carry the
// request's `origin_id|origin_text`, `destination_id|destination_text` and `stops` (the
// `submit_request` shape); a Sadran reservation (no served request) goes through `edit_ride`
// with `origin_id`/`destination_id` directly. Pure: no React, no Supabase.
import { destinationValuesToStopPayload } from "@/features/requests/stops";
import type { DestinationValue } from "@/components/DestinationCombobox";

export interface RouteEditValues {
  origin: DestinationValue | null;
  destination: DestinationValue | null;
  outStops: DestinationValue[];
  returnStops: DestinationValue[];
}

/** Stable text of a value, for change detection. */
function valueKey(value: DestinationValue | null): string {
  if (!value) return "";
  return "presetId" in value ? `p:${value.presetId}` : `t:${value.freeText.trim()}`;
}

export function routeEditKey(values: RouteEditValues): string {
  return JSON.stringify([valueKey(values.origin), valueKey(values.destination), values.outStops.map(valueKey), values.returnStops.map(valueKey)]);
}

export function routeEditChanged(initial: RouteEditValues, next: RouteEditValues): boolean {
  return routeEditKey(initial) !== routeEditKey(next);
}

/** Shift-proposal payload for a route edit: places and the whole stop set (any array replaces it). */
export function routeEditPayload(rideId: string, values: RouteEditValues): Record<string, unknown> {
  const payload: Record<string, unknown> = { ride_id: rideId };
  if (values.origin) {
    if ("presetId" in values.origin) payload.origin_id = values.origin.presetId;
    else payload.origin_text = values.origin.freeText.trim();
  }
  if (values.destination) {
    if ("presetId" in values.destination) payload.destination_id = values.destination.presetId;
    else payload.destination_text = values.destination.freeText.trim();
  }
  payload.stops = [
    ...destinationValuesToStopPayload(values.outStops, "out"),
    ...destinationValuesToStopPayload(values.returnStops, "return"),
  ];
  return payload;
}

/** A reservation's route is two list places (`edit_ride` has no free text or stops). */
export function reservationRoutePlaces(values: RouteEditValues): { originId: string; destinationId: string } | null {
  if (!values.origin || !values.destination || !("presetId" in values.origin) || !("presetId" in values.destination)) return null;
  return { originId: values.origin.presetId, destinationId: values.destination.presetId };
}

export interface RouteEditSource {
  /** The ride's served request this edit applies to (the driver's, else the first), or `null` for a reservation. */
  request: {
    origin_id: string | null; origin_text: string | null; origin_resolved_name: string | null;
    destination_id: string | null; destination_text: string | null; destination_resolved_name: string | null;
    trip_shape: string;
  } | null;
  /** That request's stops as `v_board_rides.served[].stops` (leg/position ordered). */
  stops: readonly { leg: "out" | "return"; position: number; place_id: string | null; place_text: string | null; name: string }[];
  /** The ride's own places - a reservation's whole route. */
  ride: { origin_id: string | null; origin_name: string | null; destination_id: string | null; destination_name: string | null };
  homeId?: string | null;
  placeName: (id: string) => string | undefined;
}

function preset(id: string | null | undefined, name: string | null | undefined, text: string | null | undefined, lookup: (id: string) => string | undefined): DestinationValue | null {
  if (id) return { presetId: id, name: name ?? lookup(id) ?? "" };
  return text ? { freeText: text } : null;
}

/** The editor's starting values: the request's own route, or a reservation's ride places. */
export function initialRouteEditValues(source: RouteEditSource): RouteEditValues {
  const { request } = source;
  if (!request) {
    return {
      origin: preset(source.ride.origin_id, source.ride.origin_name, null, source.placeName),
      destination: preset(source.ride.destination_id, source.ride.destination_name, null, source.placeName),
      outStops: [], returnStops: [],
    };
  }
  const stopsOf = (leg: "out" | "return") => source.stops.filter((stop) => stop.leg === leg).sort((a, b) => a.position - b.position)
    .map((stop): DestinationValue => (stop.place_id ? { presetId: stop.place_id, name: stop.name } : { freeText: stop.place_text ?? stop.name }));
  return {
    origin: request.origin_id || request.origin_text
      ? preset(request.origin_id, request.origin_resolved_name, request.origin_text, source.placeName)
      : preset(source.homeId, null, null, source.placeName),
    destination: preset(request.destination_id, request.destination_resolved_name, request.destination_text, source.placeName),
    outStops: stopsOf("out"),
    returnStops: request.trip_shape === "round_trip" ? stopsOf("return") : [],
  };
}
