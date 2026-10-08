// Pure payload builders shared by the proposal composer and the board's "draft" action
// (REQ §13.94, docs/BOARD_DRAFTS_PLAN_2026-10.md §1): both must hand `create_proposal` exactly
// the same payload for the same prefill. No React, no Supabase.
//
// `proposals_payload_shape_ck` (`validate_proposal_payload`) requires type-specific keys — an
// empty `{}` payload is rejected outright, so `null` here means "not ready" (a required field
// is still missing).
import { fromZonedTime } from "date-fns-tz";

import { TZ, dateKey } from "@/lib/time";
import type { ProposalType } from "@/lib/enums";

export interface ProposalPayloadRequest {
  depart_at: string | null;
  return_at: string | null;
  trip_shape: string;
}

/** `instant`'s calendar day (Asia/Jerusalem) at `time` ("HH:mm"); `instant` itself when no override. */
export function atTime(instant: string | null | undefined, time: string | null): string | null | undefined {
  return instant && time ? fromZonedTime(`${dateKey(instant)}T${time}:00`, TZ).toISOString() : instant;
}

/**
 * The shift proposal's starting depart/return instants: the prefill's own values, else the
 * request's; a return on a later day than the departure is clamped to 23:59 of the departure
 * day (a ride never crosses midnight).
 */
export function resolveShiftTimes(
  prefillPayload: Record<string, unknown> | undefined,
  request: Pick<ProposalPayloadRequest, "depart_at" | "return_at"> | undefined,
): { departAt: string | null | undefined; returnAt: string | null | undefined } {
  const departAt = typeof prefillPayload?.depart_at === "string" ? prefillPayload.depart_at : request?.depart_at;
  const requestedReturnAt = typeof prefillPayload?.return_at === "string" ? prefillPayload.return_at : request?.return_at;
  const returnAt = departAt && requestedReturnAt && dateKey(departAt) !== dateKey(requestedReturnAt)
    ? fromZonedTime(`${dateKey(departAt)}T23:59:00`, TZ).toISOString()
    : requestedReturnAt;
  return { departAt, returnAt };
}

export interface BuildProposalPayloadInput {
  type: ProposalType;
  prefillPayload: Record<string, unknown> | undefined;
  request: ProposalPayloadRequest | undefined;
  rideId: string | null;
  /** Shift only: already includes any time override the Sadran typed in the composer. */
  proposedDepartAt?: string | null;
  proposedReturnAt?: string | null;
  effectiveReason: string;
  externalHint: string;
  /** External only: the request starts at a list place other than home -> "no car in your town" (REQ §13.101 b). */
  originAway?: boolean;
}

const PLACE_EDIT_KEYS = ["origin_id", "origin_text", "destination_id", "destination_text", "stops"] as const;

/**
 * REQ §13.94 (G8): a ride-detail "מסלול" edit is a shift made only of places/stops - no car, no
 * times (the ride keeps its window; `apply_proposal` re-places it).
 */
export function isPlaceOnlyShift(prefillPayload: Record<string, unknown> | undefined): boolean {
  if (!prefillPayload) return false;
  if ("depart_at" in prefillPayload || "return_at" in prefillPayload || "car_id" in prefillPayload) return false;
  return PLACE_EDIT_KEYS.some((key) => key in prefillPayload);
}

/** REQ §13.101 (j): a shift that shortens a multi-day request carries `series_span` + `car_id`. */
export function seriesSpanOf(prefillPayload: Record<string, unknown> | undefined): { depart_at: string; return_at: string } | null {
  const span = prefillPayload?.series_span;
  if (!span || typeof span !== "object") return null;
  const { depart_at, return_at } = span as Record<string, unknown>;
  return typeof depart_at === "string" && typeof return_at === "string" && Date.parse(return_at) > Date.parse(depart_at) ? { depart_at, return_at } : null;
}

export function buildProposalPayload(input: BuildProposalPayloadInput): Record<string, unknown> | null {
  const { type, prefillPayload, request, rideId } = input;
  if (type === "shift" && prefillPayload && "series_span" in prefillPayload) {
    const span = seriesSpanOf(prefillPayload);
    return span && typeof prefillPayload.car_id === "string" ? { car_id: prefillPayload.car_id, series_span: span } : null;
  }
  if (type === "shift" && isPlaceOnlyShift(prefillPayload)) return { ...prefillPayload };
  if (type === "shift") {
    // R4B4: a one-leg shift (`leg`) keeps only that leg's time - the request's other time must not leak in.
    const leg = prefillPayload?.leg;
    const departAt = leg === "return" ? null : input.proposedDepartAt;
    const returnAt = leg === "out" ? null : input.proposedReturnAt;
    if (!departAt && !returnAt) return null;
    if (departAt && returnAt && (Date.parse(returnAt) <= Date.parse(departAt) || dateKey(departAt) !== dateKey(returnAt))) return null;
    // A time/car shift never carries places (apply_proposal would overwrite the request's route).
    const rest = { ...prefillPayload };
    for (const key of PLACE_EDIT_KEYS) delete rest[key];
    return { ...rest, depart_at: departAt, return_at: returnAt };
  }
  if (type === "deny") return { ...prefillPayload, reason: input.effectiveReason };
  if (type === "external") {
    return { ...prefillPayload, hint: input.externalHint, reason: input.effectiveReason, ...(input.originAway ? { external_reason: "city" } : {}) };
  }
  if (type === "merge") {
    if (!rideId) return null;
    const legs = Array.isArray(prefillPayload?.legs)
      ? prefillPayload.legs
      : [{ ride_id: rideId, role: "passenger", leg: request?.trip_shape === "one_way_to" ? "out" : request?.trip_shape === "one_way_from" ? "return" : "both", car_mode: "passenger" }];
    // REQ §13.94 (G10): legs only - the base keeps its times and `apply_proposal` grows the end by
    // the added driving. A window already in the prefill (legacy expanded merge) is passed through.
    return { ...prefillPayload, ride_id: rideId, legs };
  }
  if (type === "origin") {
    const originId = typeof prefillPayload?.origin_id === "string" ? prefillPayload.origin_id : undefined;
    const carId = typeof prefillPayload?.car_id === "string" ? prefillPayload.car_id : undefined;
    if (!originId || !carId) return null;
    return { origin_id: originId, car_id: carId };
  }
  if (type === "alternative") {
    // REQ §13.112 (a): the placement of the member's plan B. The places and the plan's own times come from the request's
    // `request_alternatives` row (`create_proposal` completes the payload from it); only the car(s) and the member's own
    // two times (leaves home / is back) are ours.
    const carId = typeof prefillPayload?.car_id === "string" ? prefillPayload.car_id : undefined;
    const departAt = typeof prefillPayload?.depart_at === "string" ? prefillPayload.depart_at : undefined;
    if (!carId || !departAt) return null;
    const returnAt = typeof prefillPayload?.return_at === "string" ? prefillPayload.return_at : undefined;
    const returnCarId = typeof prefillPayload?.return_car_id === "string" ? prefillPayload.return_car_id : undefined;
    return {
      car_id: carId, depart_at: departAt,
      ...(returnAt ? { return_at: returnAt } : {}),
      ...(returnCarId && returnCarId !== carId ? { return_car_id: returnCarId } : {}),
      ...(prefillPayload?.allow_small_trunk === true ? { allow_small_trunk: true } : {}),
    };
  }
  return null;
}
