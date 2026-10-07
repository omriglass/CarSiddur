// Board drafts (REQ §13.94, docs/BOARD_DRAFTS_PLAN_2026-10.md §1): a draft is a `proposals` row
// with `status = 'draft'`. This pure module resolves each one to "the result it would
// produce" - car, window, places - for the board overlay (dashed block) and for the solver
// context (a fixed block on its car, so auto-fill never double-books it). No React, no Supabase.
import { servedOf } from "../applySolve";
import { mergePayloadLeg, previewMerge, type MergeRouteContext } from "./mergeProposal";
import { requestWindow } from "./phantomLanes";

import type { BoardRide, ProposalRow, WeekRequestRow } from "../api";

export interface DraftPlacement {
  proposalId: string;
  requestId: string;
  type: "shift" | "merge" | "origin";
  status: ProposalRow["status"];
  carId: string;
  startsAt: string;
  endsAt: string;
  originId: string | null;
  destinationId: string | null;
  /** Merge: the host ride the guest would join. */
  hostRideId: string | null;
  /** Shift: the request's current ride the draft replaces (its block is hidden while the draft shows). */
  replacesRideId: string | null;
  /** Shift of ONE leg of a הקפצה (payload `leg`, else inferred from the single time it carries): the label says "איסוף מ..." for `return`. */
  leg?: "out" | "return" | null;
}

/** Per merge proposal id: the merged ride's window as the server's `merge_preview` computed it (REQ item 108 M1). */
export type ServerMergeWindows = ReadonlyMap<string, { startsAt: string; endsAt: string }>;

function payloadOf(proposal: Pick<ProposalRow, "payload">): Record<string, unknown> {
  const payload = proposal.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
}

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** The ride (if any) that currently serves `requestId`. */
function rideServing(rides: readonly BoardRide[], requestId: string, preferredId: string | null): BoardRide | undefined {
  return rides.find((ride) => ride.id === preferredId)
    ?? rides.find((ride) => servedOf(ride).some((entry) => entry.request_id === requestId));
}

/**
 * Placement of one proposal, or `null` when it does not put the request anywhere on a car
 * (deny/external, or a shift draft with neither a car in its payload nor a ride to stay on).
 */
export function resolveDraftPlacement(
  proposal: ProposalRow,
  requests: readonly WeekRequestRow[],
  rides: readonly BoardRide[],
  homeId?: string,
  route?: Pick<MergeRouteContext, "hop" | "stopMinutes" | "hopKm" | "detourLimitMinutes" | "detourLimitKm">,
  serverMergeWindows?: ServerMergeWindows,
): DraftPlacement | null {
  const request = requests.find((r) => r.id === proposal.request_id);
  if (!request || !proposal.request_id) return null;
  const payload = payloadOf(proposal);
  const common = { proposalId: proposal.id, requestId: request.id, status: proposal.status };

  if (proposal.type === "merge") {
    // REQ §13.94 (G10): the merged ride keeps the host's start and grows only by the added
    // driving (route twin); a legacy payload window (`starts_at`/`ends_at`) still widens it.
    const host = rides.find((ride) => ride.id === proposal.ride_id);
    if (!host?.car_id || !host.starts_at || !host.ends_at) return null;
    const preview = route ? previewMerge(host, request, mergePayloadLeg(payload, request), { ...route, homeId }) : null;
    // REQ item 108 (M1): the server's `merge_preview` window wins; the route twin is the fallback while it loads or fails.
    const server = serverMergeWindows?.get(proposal.id);
    const startsAt = new Date(Math.min(Date.parse(server?.startsAt ?? preview?.startsAt ?? host.starts_at), Date.parse(str(payload.starts_at) ?? host.starts_at))).toISOString();
    const endsAt = new Date(Math.max(Date.parse(server?.endsAt ?? preview?.endsAt ?? host.ends_at), Date.parse(str(payload.ends_at) ?? host.ends_at))).toISOString();
    return { ...common, type: "merge", carId: host.car_id, startsAt, endsAt,
      originId: host.origin_id, destinationId: host.destination_id, hostRideId: host.id, replacesRideId: null };
  }

  if (proposal.type === "origin") {
    const carId = str(payload.car_id);
    const window = requestWindow(request);
    if (!carId || !window) return null;
    return { ...common, type: "origin", carId, startsAt: window.startsAt, endsAt: window.endsAt,
      originId: str(payload.origin_id), destinationId: request.destination_id, hostRideId: null, replacesRideId: null };
  }

  if (proposal.type === "shift") {
    // REQ §13.105 d: a fewer-days shift is drawn on the span's own day(s) on the chosen car, not on the series head's day.
    const spanRaw = payload.series_span && typeof payload.series_span === "object" ? (payload.series_span as Record<string, unknown>) : null;
    const spanStart = spanRaw ? str(spanRaw.depart_at) : null;
    const spanEnd = spanRaw ? str(spanRaw.return_at) : null;
    const spanCar = str(payload.car_id);
    if (spanStart && spanEnd && spanCar && Date.parse(spanEnd) > Date.parse(spanStart)) {
      const spanRide = rideServing(rides, request.id, proposal.ride_id);
      return { ...common, type: "shift", carId: spanCar, startsAt: spanStart, endsAt: spanEnd,
        originId: request.origin_id ?? homeId ?? null, destinationId: request.origin_id ?? homeId ?? null,
        hostRideId: null, replacesRideId: spanRide?.id ?? null };
    }
    const departAt = str(payload.depart_at);
    const returnAt = str(payload.return_at);
    // R4B4: one leg of a split drop-off is drawn as that leg only, never as the whole request window
    // replacing the other leg's ride.
    // The leg is inferred the way the server does (`_shift_place_on_car`): a drop-off shift carrying a single time.
    const inferredLeg = request.trip_type === "drop_off" && !payload.leg ? (returnAt && !departAt ? "return" : departAt && !returnAt ? "out" : null) : null;
    const leg = payload.leg === "out" || payload.leg === "return" ? payload.leg : inferredLeg;
    const legCar = str(payload.car_id);
    if (leg && legCar) {
      const win = leg === "return" && returnAt
        ? requestWindow({ ...request, trip_shape: "one_way_from", return_at: returnAt })
        : leg === "out" && departAt ? requestWindow({ ...request, trip_shape: "one_way_to", depart_at: departAt, return_at: null }) : null;
      if (!win) return null;
      return { ...common, type: "shift", carId: legCar, startsAt: win.startsAt, endsAt: win.endsAt,
        originId: str(payload.origin_id) ?? request.origin_id ?? homeId ?? null,
        destinationId: str(payload.destination_id) ?? request.destination_id, hostRideId: null, replacesRideId: null, leg };
    }
    const ride = rideServing(rides, request.id, proposal.ride_id);
    const carId = str(payload.car_id) ?? ride?.car_id ?? null;
    const base = ride?.starts_at && ride.ends_at ? { startsAt: ride.starts_at, endsAt: ride.ends_at } : requestWindow(request);
    if (!carId || !base) return null;
    const baseMs = Date.parse(base.endsAt) - Date.parse(base.startsAt);
    let start = Date.parse(base.startsAt);
    let end = Date.parse(base.endsAt);
    if (request.trip_shape === "round_trip") {
      if (departAt) start = Date.parse(departAt);
      if (returnAt) end = Date.parse(returnAt);
    } else if (request.trip_shape === "one_way_from") {
      if (returnAt) end = Date.parse(returnAt);
      start = end - baseMs;
    } else {
      if (departAt) start = Date.parse(departAt);
      end = start + baseMs;
    }
    if (!(end > start)) return null;
    const home = homeId ?? null;
    const roundOrigin = str(payload.origin_id) ?? ride?.origin_id ?? request.origin_id ?? home;
    return { ...common, type: "shift", carId, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(),
      originId: roundOrigin,
      destinationId: str(payload.destination_id) ?? ride?.destination_id ?? (request.trip_shape === "round_trip" ? roundOrigin : request.destination_id),
      hostRideId: null, replacesRideId: ride?.id ?? null };
  }
  return null;
}

/** Statuses whose proposal keeps its request out of re-solving (REQ §13.94). */
export const OPEN_PROPOSAL_STATUSES = ["draft", "sent", "accepted"] as const;

export function hasOpenProposal(proposal: Pick<ProposalRow, "status">): boolean {
  return (OPEN_PROPOSAL_STATUSES as readonly string[]).includes(proposal.status);
}

/** Request ids that have a draft/sent/accepted proposal: the solver leaves them alone. */
export function requestIdsWithOpenProposal(proposals: readonly Pick<ProposalRow, "status" | "request_id">[]): Set<string> {
  return new Set(proposals.filter(hasOpenProposal).flatMap((p) => (p.request_id ? [p.request_id] : [])));
}

/** Placements of every `draft` proposal that resolves to a car + window. */
export function resolveDraftPlacements(
  proposals: readonly ProposalRow[],
  requests: readonly WeekRequestRow[],
  rides: readonly BoardRide[],
  homeId?: string,
  route?: Pick<MergeRouteContext, "hop" | "stopMinutes" | "hopKm" | "detourLimitMinutes" | "detourLimitKm">,
  serverMergeWindows?: ServerMergeWindows,
): DraftPlacement[] {
  return proposals
    .filter((proposal) => proposal.status === "draft")
    .flatMap((proposal) => {
      const placement = resolveDraftPlacement(proposal, requests, rides, homeId, route, serverMergeWindows);
      return placement ? [placement] : [];
    });
}
