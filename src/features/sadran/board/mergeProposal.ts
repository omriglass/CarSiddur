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
export function mergeLegOptions(request: Pick<WeekRequestRow, "trip_shape">, anchorLeg?: "out" | "return" | null): { preset: MergeLeg | null; choices: readonly MergeLeg[] } {
  if (request.trip_shape === "one_way_to") return { preset: "out", choices: ["out"] };
  if (request.trip_shape === "one_way_from") return { preset: "return", choices: ["return"] };
  // R2B25: a card for the request's RETURN leg offers "חזור בלבד" (and both), not the out leg.
  if (anchorLeg === "return") return { preset: null, choices: ["return", "both"] };
  return { preset: null, choices: ["out", "both"] };
}

/** The leg a merge starts on for a card: the preset of a one-leg request, else the card's own leg (`out` when none). */
export function mergeLegForCard(request: Pick<WeekRequestRow, "trip_shape">, cardLeg?: "out" | "return" | null): MergeLeg {
  return mergeLegOptions(request, cardLeg).preset ?? (cardLeg === "return" ? "return" : "out");
}

/** The default leg: the preset, else the whole round trip. */
export function defaultMergeLeg(request: Pick<WeekRequestRow, "trip_shape">): MergeLeg {
  return mergeLegOptions(request).preset ?? "out";
}

/** The full merge payload (never a window): `{ ride_id, legs }`. */
export function mergePayload(hostRideId: string, leg: MergeLeg): Record<string, unknown> {
  return { ride_id: hostRideId, legs: [{ ride_id: hostRideId, role: "passenger", leg, car_mode: "passenger" }] };
}

export interface MergeLegRef { ride_id: string; leg: MergeLeg }

/** Every `{ride_id, leg}` stored in a merge payload (the payload may carry two rides - a split merge, REQ §13.102 d). */
export function mergePayloadLegs(payload: unknown): MergeLegRef[] {
  const legs = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as { legs?: unknown }).legs : undefined;
  if (!Array.isArray(legs)) return [];
  return legs.flatMap((entry) => {
    const e = entry as { ride_id?: unknown; leg?: unknown } | null;
    return e && typeof e.ride_id === "string" && (e.leg === "out" || e.leg === "return" || e.leg === "both") ? [{ ride_id: e.ride_id, leg: e.leg }] : [];
  });
}

/** The merge payload for several `{ride_id, leg}` (first = the ride the proposal hangs on: the out leg's, else the first). */
export function mergePayloadFromLegs(legs: readonly MergeLegRef[]): Record<string, unknown> {
  const sorted = [...legs].sort((a, b) => (a.leg === "return" ? 1 : 0) - (b.leg === "return" ? 1 : 0));
  return { ride_id: sorted[0]!.ride_id, legs: sorted.map((entry) => ({ ride_id: entry.ride_id, role: "passenger", leg: entry.leg, car_mode: "passenger" })) };
}

/**
 * REQ §13.102 (d, R2M2/R2B13): a merge dropped for a request that already has an open merge draft
 * extends it - the old draft keeps the legs the new one does not cover (out on ride A + return on
 * ride B). `replaced` is true when the new leg covers everything the old draft had (the draft is
 * replaced, and the Sadran is told so instead of it vanishing silently).
 */
export function combineMergeLegs(existing: readonly MergeLegRef[], added: MergeLegRef): { legs: MergeLegRef[]; replaced: boolean } {
  const kept: MergeLegRef[] = [];
  for (const old of existing) {
    if (added.leg === "both" || old.leg === added.leg) continue;
    if (old.leg === "both") kept.push({ ride_id: old.ride_id, leg: added.leg === "out" ? "return" : "out" });
    else kept.push(old);
  }
  // Out and return on the same ride is simply "both".
  if (kept.length === 1 && kept[0]!.ride_id === added.ride_id) return { legs: [{ ride_id: added.ride_id, leg: "both" }], replaced: false };
  return { legs: [...kept, added], replaced: kept.length === 0 };
}

/** The leg stored in a merge payload (first entry), else the request's default. */
export function mergePayloadLeg(payload: unknown, request: Pick<WeekRequestRow, "trip_shape">): MergeLeg {
  const legs = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as { legs?: unknown }).legs : undefined;
  const first = Array.isArray(legs) ? (legs[0] as { leg?: unknown } | undefined) : undefined;
  return first?.leg === "out" || first?.leg === "return" || first?.leg === "both" ? first.leg : defaultMergeLeg(request);
}

/** The legs a merge payload covers, over all its rides: "out", "return" or "both" (a split merge is "both"). */
export function mergeLegSummary(payload: unknown, request: Pick<WeekRequestRow, "trip_shape">): MergeLeg {
  const sides = new Set(mergePayloadLegs(payload).map((entry) => entry.leg));
  if (sides.size === 1) return [...sides][0]!;
  return sides.size > 1 ? "both" : mergePayloadLeg(payload, request);
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
  /** R4B5/R4U3: the joiner's own estimated boarding time per leg (15-minute grid), `null` when they do not ride that leg. */
  joinerOutAt: string | null;
  joinerReturnAt: string | null;
}

/** The host ride as it would be once `request` joins on `leg`. */
export function previewMerge(host: BoardRide, request: WeekRequestRow, leg: MergeLeg, ctx: MergeRouteContext): MergePreview | null {
  if (!host.starts_at || !host.ends_at) return null;
  const stored = parseRideRoute(host.route);
  const baseRoute = stored.length ? stored : fallbackRoute({
    startsAt: host.starts_at, endsAt: host.ends_at,
    originId: host.origin_id, originName: host.origin_name,
    destinationId: host.destination_id, destinationName: host.destination_name,
  });
  // R3B6: a return-only guest joins a host whose single stored leg is "out" (a pickup/chauffeur ride has
  // no separate return leg): that one leg is the leg the guest rides, so the stop time can be computed.
  const route = leg === "return" && !baseRoute.some((point) => point.leg === "return")
    ? baseRoute.map((point) => ({ ...point, leg: "return" as const }))
    : baseRoute;
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
  // R2B25: the stop ETA is shown on the 15-minute grid (like every ride time), never 12:53.
  merged.boardEta = merged.boardEta ? new Date(Math.round(Date.parse(merged.boardEta) / 900_000) * 900_000).toISOString() : null;
  const timeChanges = !!merged.boardEta && !!requestedAt && Math.round(Date.parse(merged.boardEta) / 60_000) !== Math.round(Date.parse(requestedAt) / 60_000);
  const grid = (iso: string | null | undefined) => (iso ? new Date(Math.round(Date.parse(iso) / 900_000) * 900_000).toISOString() : null);
  const boardAt = (side: "out" | "return") => grid(merged.route.find((p) => p.requestId === request.id && p.kind === "board" && p.leg === side)?.eta);
  return { ...merged, requestedAt: requestedAt ?? null, timeChanges, joinerOutAt: boardAt("out"), joinerReturnAt: boardAt("return") };
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
