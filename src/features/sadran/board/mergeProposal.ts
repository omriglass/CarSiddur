// REQ §13.94 (G10): a merge is one ride. Pure helpers shared by the board's merge popup, the
// drag paths and the suggestion path so they all build the SAME payload: legs only - the host
// keeps its start and its end grows by the added driving (computed by `apply_proposal` from the
// ride route; `src/lib/rideRoute.ts` is the TS twin used to preview it). No React, no Supabase.
import { fallbackRoute, mergePassengerIntoRoute, parseRideRoute, type Hop, type HopKm, type MergedRoute, type MergeInvalid } from "@/lib/rideRoute";

import type { BoardRide, WeekRequestRow } from "../api";

export type MergeLeg = "out" | "return" | "both";

/**
 * The legs a request may join: a request that is itself one-leg (one-way to / from) has its leg
 * preset and the popup hides the choice; a request with a pickup chooses "הלוך בלבד" (`out`) or
 * "הלוך וחזור" (`both`).
 */
export function mergeLegOptions(request: Pick<WeekRequestRow, "trip_shape">): { preset: MergeLeg | null; choices: readonly MergeLeg[] } {
  if (request.trip_shape === "one_way_to") return { preset: "out", choices: ["out"] };
  if (request.trip_shape === "one_way_from") return { preset: "return", choices: ["return"] };
  return { preset: null, choices: ["out", "both"] };
}

/** The default leg: the preset, else the whole round trip. */
export function defaultMergeLeg(request: Pick<WeekRequestRow, "trip_shape">): MergeLeg {
  return mergeLegOptions(request).preset ?? "out";
}

/** The full merge payload (never a window): `{ ride_id, legs }`. */
export function mergePayload(hostRideId: string, leg: MergeLeg): Record<string, unknown> {
  return { ride_id: hostRideId, legs: [{ ride_id: hostRideId, role: "passenger", leg, car_mode: "passenger" }] };
}

/** The leg stored in a merge payload (first entry), else the request's default. */
export function mergePayloadLeg(payload: unknown, request: Pick<WeekRequestRow, "trip_shape">): MergeLeg {
  const legs = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as { legs?: unknown }).legs : undefined;
  const first = Array.isArray(legs) ? (legs[0] as { leg?: unknown } | undefined) : undefined;
  return first?.leg === "out" || first?.leg === "return" || first?.leg === "both" ? first.leg : defaultMergeLeg(request);
}

export interface MergeRouteContext {
  hop: Hop;
  stopMinutes: number;
  homeId?: string | null;
  /** REQ §13.95 (H1): the department's detour limits (`department_settings`) and the km lookup. */
  detourLimitMinutes?: number | null;
  detourLimitKm?: number | null;
  hopKm?: HopKm;
}

export interface MergePreview extends MergedRoute {
  /** When the passenger asked to be at their stop (their depart/return time), `null` if unknown. */
  requestedAt: string | null;
  /** The estimated time differs from the requested one (to the minute). */
  timeChanges: boolean;
}

/** The host ride as it would be once `request` joins on `leg`. */
export function previewMerge(host: BoardRide, request: WeekRequestRow, leg: MergeLeg, ctx: MergeRouteContext): MergePreview | null {
  if (!host.starts_at || !host.ends_at) return null;
  const stored = parseRideRoute(host.route);
  const route = stored.length ? stored : fallbackRoute({
    startsAt: host.starts_at, endsAt: host.ends_at,
    originId: host.origin_id, originName: host.origin_name,
    destinationId: host.destination_id, destinationName: host.destination_name,
  });
  const merged = mergePassengerIntoRoute({
    route, startsAt: host.starts_at, endsAt: host.ends_at, hop: ctx.hop, stopMinutes: ctx.stopMinutes,
    detourLimitMinutes: ctx.detourLimitMinutes, detourLimitKm: ctx.detourLimitKm, hopKm: ctx.hopKm,
    passenger: {
      requestId: request.id,
      name: request.requester_full_name,
      originId: request.origin_id ?? (request.origin_text ? null : ctx.homeId ?? null),
      originText: request.origin_text,
      originName: request.origin_resolved_name ?? (request.origin_id ? null : request.origin_text),
      destinationId: request.destination_id,
      destinationText: request.destination_text,
      destinationName: request.destination_resolved_name ?? request.destination_text,
      leg,
    },
  });
  const requestedAt = merged.boardLeg === "return" ? request.return_at : request.depart_at;
  const timeChanges = !!merged.boardEta && !!requestedAt && Math.round(Date.parse(merged.boardEta) / 60_000) !== Math.round(Date.parse(requestedAt) / 60_000);
  return { ...merged, requestedAt: requestedAt ?? null, timeChanges };
}

/**
 * REQ §13.95 (H1): why dropping `request` onto `host` is not a valid merge, or `null` when it is
 * (or when the host has no times / route data to judge by).
 */
export function mergeInvalidReason(host: BoardRide, request: WeekRequestRow, leg: MergeLeg, ctx: MergeRouteContext | undefined): MergeInvalid | null {
  if (!ctx) return null;
  const preview = previewMerge(host, request, leg, ctx);
  return preview && !preview.valid ? preview.invalid : null;
}

/**
 * The people a merge added to a ride: every served request except the base (the driver's, else
 * the first - the same base the SQL route and `unmerge_request` use).
 */
export function addedGuestsOf(
  rideId: string,
  served: readonly { request_id: string | null; role: string; requester?: string | null }[],
): { requestId: string; rideId: string; name: string }[] {
  const base = served.find((entry) => entry.role === "driver") ?? served[0];
  return served.flatMap((entry) => (entry.request_id && entry.request_id !== base?.request_id
    ? [{ requestId: entry.request_id, rideId, name: entry.requester ?? "" }] : []));
}
