// REQ §13.94 (G10): a merge is one ride. Pure helpers shared by the board's merge popup, the
// drag paths and the suggestion path so they all build the SAME payload: legs only - the host
// keeps its start and its end grows by the added driving (computed by `apply_proposal` from the
// ride route; `src/lib/rideRoute.ts` is the TS twin used to preview it). No React, no Supabase.
import { parseChain, type MergeChain } from "@/features/rides/mergeChain";
import { he, tv } from "@/i18n/he";
import { isTightSchedule, parseLongDetour, type LongDetour, type MergeWaitChoice } from "@/features/rides/mergeQuestions";
import { parseFlexInterval } from "@/features/solverBridge/buildSolverInput";
import { formatTime } from "@/lib/time";
import { fallbackRoute, mergePassengerIntoRoute, parseRideRoute, routeEtas, type Hop, type HopKm, type MergedRoute, type MergeInvalid, type RoutePoint } from "@/lib/rideRoute";
import { servedOf } from "@/features/rides/servedOf";
import { mergeAffectedRequestIds } from "./mergeAffected";

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
  /** CM1 phase 2 (REQ item 260 b): the merge joins two trips one after the other into one ride (from `merge_preview`). */
  chain?: MergeChain | null;
}

/** The host ride's route timed by the same twin as `previewMerge` (so its times compare with the merged route's). */
function hostRouteTimed(host: BoardRide, leg: MergeLeg, ctx: MergeRouteContext): RoutePoint[] {
  const stored = parseRideRoute(host.route);
  const base = stored.length ? stored : fallbackRoute({
    startsAt: host.starts_at!, endsAt: host.ends_at!,
    originId: host.origin_id, originName: host.origin_name,
    destinationId: host.destination_id, destinationName: host.destination_name,
  });
  const route = leg === "return" && !base.some((point) => point.leg === "return") ? base.map((point) => ({ ...point, leg: "return" as const })) : base;
  const startMs = Date.parse(host.starts_at!); const endMs = Date.parse(host.ends_at!);
  const ofLeg = (side: "out" | "return") => route.filter((p) => p.leg === side).sort((a, b) => a.position - b.position);
  return [
    ...(ofLeg("out").length ? routeEtas(ofLeg("out"), "out", startMs, endMs, ctx.hop, ctx.stopMinutes) : []),
    ...(ofLeg("return").length ? routeEtas(ofLeg("return"), "return", startMs, endMs, ctx.hop, ctx.stopMinutes) : []),
  ];
}

/**
 * R22B9 / R22U3 (owner 2026-11-22): the host's trips a merge onto `host` changes - those whose times move
 * (`mergeAffectedRequestIds`; the driver is always affected) - and their requesters (`affected_parties`: only they
 * and the driver must accept the proposal). `null` when it cannot tell (no preview, no hours, a
 * chain) - the caller then names everyone on the ride, as before.
 */
export function mergeAffectedParties(host: BoardRide, request: WeekRequestRow, leg: MergeLeg, ctx: MergeRouteContext,
  preview: MergePreview | null, requests: readonly WeekRequestRow[]): { requestIds: Set<string>; requesterIds: string[] } | null {
  if (!preview?.valid || preview.chain || !host.starts_at || !host.ends_at) return null;
  const byId = new Map(requests.map((r) => [r.id, r]));
  const trips = servedOf(host).flatMap((entry) => (entry.request_id && entry.request_id !== request.id ? [{ ...entry, request_id: entry.request_id }] : [])).map((entry) => {
    const own = byId.get(entry.request_id);
    return { requestId: entry.request_id, leg: entry.leg as "out" | "return" | "both",
      originId: own?.origin_id ?? ctx.homeId ?? null, destinationId: own?.destination_id ?? null };
  });
  const requestIds = mergeAffectedRequestIds({
    before: hostRouteTimed(host, leg, ctx), merged: preview.route,
    startsAt: host.starts_at, newStartsAt: preview.startsAt, endsAt: host.ends_at, newEndsAt: preview.endsAt, trips,
  });
  const requesterIds = [...new Set([...requestIds].flatMap((id) => { const who = byId.get(id)?.requester_id; return who ? [who] : []; }))].sort();
  return { requestIds, requesterIds };
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
      oneWay: request.trip_shape === "one_way_to",
    },
  });
  // R6B5: a reversed one-way boards on the host's return leg but still asks for its own departure time.
  const requestedAt = merged.boardLeg === "return" && !merged.swapped ? request.return_at : request.depart_at;
  const grid = (iso: string | null | undefined) => (iso ? new Date(Math.round(Date.parse(iso) / 900_000) * 900_000).toISOString() : null);
  // R2B25: the stop ETA is shown on the 15-minute grid (like every ride time), never 12:53.
  merged.boardEta = grid(merged.boardEta);
  const boardAt = (side: "out" | "return") => grid(merged.route.find((p) => p.requestId === request.id && p.kind === "board" && p.leg === side)?.eta);
  // R6B10: the guest's return is the ARRIVAL at their origin (the request's own return time), not the time they leave the destination.
  const originId = request.origin_id ?? ctx.homeId ?? null;
  const alightAt = () => grid((merged.route.find((p) => p.requestId === request.id && p.kind === "alight" && p.leg === "return")
    ?? [...merged.route].reverse().find((p) => p.leg === "return" && p.position > 0 && !!originId && p.placeId === originId))?.eta);
  const joinerOutAt = merged.swapped
    ? (boardAt("return") ?? grid(merged.route.find((p) => p.leg === "return" && !!originId && p.placeId === originId)?.eta))
    : boardAt("out");
  const joinerReturnAt = merged.swapped ? null : (alightAt() ?? boardAt("return"));
  if (merged.boardLeg === "return" && !merged.swapped && joinerReturnAt) merged.boardEta = joinerReturnAt;
  const timeChanges = !!merged.boardEta && !!requestedAt && Math.round(Date.parse(merged.boardEta) / 60_000) !== Math.round(Date.parse(requestedAt) / 60_000);
  return { ...merged, requestedAt: requestedAt ?? null, timeChanges, joinerOutAt, joinerReturnAt };
}

/**
 * R5B5 / TODO U2: the server's `merge_preview` (SQL `_merge_check` + `_joiner_times`) is the one
 * source of the merged ride's window and the joiner's own times; the popup, the composer and the
 * draft text show these instead of the TS route twin's estimate (which still drives the route
 * picture and the synchronous drag validity).
 */
export interface ServerMergePreview {
  ok: boolean;
  code: string | null;
  /** The ride's window after the merge. */
  newStartsAt: string | null;
  newEndsAt: string | null;
  joinerDepartAt: string | null;
  joinerReturnAt: string | null;
  /** R6B3: which neighbour a turnaround refusal clashes with (`previous` = the ride before, `next` = the ride after). */
  turnaroundSide?: "previous" | "next" | null;
  /** REQ §13.111 (a) / §13.175 (a): the only problems are ones the Sadran may accept (see `luggageWaivable` / `longDetour`). */
  waivable?: boolean;
  /** REQ §13.111 (a): a missing large trunk the Sadran may accept ("לשבץ בכל זאת", payload `allow_small_trunk`). */
  luggageWaivable?: boolean;
  /** REQ §13.200: which car needs the car lacks (`large_trunk` / `tow_hitch`) - words the "לשבץ בכל זאת?" question. */
  needs?: ("large_trunk" | "tow_hitch")[];
  /** REQ §13.175 (a): the detour is over the department's limit - the Sadran may accept it (payload `allow_long_detour`). */
  longDetour?: LongDetour | null;
  /**
   * REQ §13.175 (b): the window that makes the ride reach the guest at the guest's own time - later on the way back
   * (`endsAt`), earlier on the way out (`startsAt`); `null` when the ride already does, or the day cannot hold it.
   */
  waitWindow?: { startsAt: string | null; endsAt: string | null } | null;
  /** R12B4 (REQ §13.119): the guest's person is already on another live ride overlapping the merged ride - a warning, never a refusal. */
  personOverlaps?: { rideId: string; startsAt: string; endsAt: string; role: string }[];
  /** R13B9: the ride passes the guest's place far from the guest's own time - allowed for the Sadran, but unlikely. */
  timeFar?: TimeFar | null;
  /** REQ item 246 g: a stop's stated hour moves - shown as "לו״ז צפוף", never refused. */
  tight?: boolean;
  /** CM1 phase 2 (REQ item 260 b): the merge chains the two trips into one ride. */
  chain?: MergeChain | null;
}

/** R13B9 far from the guest's time; R19B1 `kind: "order"` = the leg lands on the wrong side of the guest's other leg. */
export interface TimeFar { eta: string; wanted: string; kind?: "far" | "order"; leg?: "out" | "return" }

const isoOrNull = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

export function parseServerMergePreview(raw: unknown): ServerMergePreview | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    ok: r.ok === true,
    code: typeof r.code === "string" ? r.code : null,
    newStartsAt: isoOrNull(r.new_starts_at),
    newEndsAt: isoOrNull(r.new_ends_at),
    joinerDepartAt: isoOrNull(r.joiner_depart_at),
    joinerReturnAt: isoOrNull(r.joiner_return_at),
    turnaroundSide: r.turnaround_side === "previous" || r.turnaround_side === "next" ? r.turnaround_side : null,
    waivable: r.waivable === true,
    // an older server sent `waivable` for a large trunk only
    luggageWaivable: r.luggage_waivable === true || (r.waivable === true && r.luggage_waivable === undefined && r.code === "luggage"),
    needs: Array.isArray(r.needs) ? r.needs.filter((n): n is "large_trunk" | "tow_hitch" => n === "large_trunk" || n === "tow_hitch") : undefined,
    longDetour: parseLongDetour(r),
    tight: isTightSchedule(r),
    chain: parseChain(r.chain),
    waitWindow: isoOrNull(r.wait_ends_at) || isoOrNull(r.wait_starts_at)
      ? { startsAt: isoOrNull(r.wait_starts_at), endsAt: isoOrNull(r.wait_ends_at) } : null,
    personOverlaps: Array.isArray(r.person_overlaps)
      ? r.person_overlaps.flatMap((o): { rideId: string; startsAt: string; endsAt: string; role: string }[] => {
        const row = o as Record<string, unknown>;
        return typeof row.ride_id === "string" && typeof row.starts_at === "string" && typeof row.ends_at === "string"
          ? [{ rideId: row.ride_id, startsAt: row.starts_at, endsAt: row.ends_at, role: typeof row.role === "string" ? row.role : "passenger" }] : [];
      })
      : [],
    timeFar: r.time_far === true && typeof r.time_far_eta === "string" && typeof r.time_far_wanted === "string"
      ? {
        eta: r.time_far_eta, wanted: r.time_far_wanted,
        ...(r.time_far_kind === "order" ? { kind: "order" as const, leg: r.time_far_leg === "out" ? "out" as const : "return" as const } : {}),
      } : null,
  };
}

/** R13B9: "the ride passes there at {eta}, the member asked for {wanted}" for a far-off merge, or `null`. */
export function timeFarWarning(timeFar: TimeFar | null | undefined): string | null {
  if (!timeFar) return null;
  const vars = { eta: formatTime(new Date(timeFar.eta)), wanted: formatTime(new Date(timeFar.wanted)) };
  if (timeFar.kind === "order") return tv(timeFar.leg === "out" ? "mergedRide.orderOut" : "mergedRide.orderReturn", vars);
  return tv("mergedRide.timeFar", vars);
}

/** The prompt's title and button for a far-off / wrong-order merge. */
export function timeFarPrompt(timeFar: TimeFar): { title: string; confirm: string } {
  return timeFar.kind === "order"
    ? { title: he.mergedRide.orderTitle, confirm: he.mergedRide.orderConfirm }
    : { title: he.mergedRide.timeFarTitle, confirm: he.mergedRide.timeFarConfirm };
}

/** R12B4: the warning line for a guest already booked on another ride at those hours, or `null`. */
export function personOverlapWarning(server: ServerMergePreview | null | undefined): string | null {
  const first = server?.personOverlaps?.[0];
  return first ? tv("mergedRide.personOverlap", { time: `${formatTime(new Date(first.startsAt))}–${formatTime(new Date(first.endsAt))}` }) : null;
}

/** `preview` with the times the server computed (display only; the route and validity stay the twin's). */
export function applyServerMergeTimes(preview: MergePreview | null, server: ServerMergePreview | null | undefined, request: Pick<WeekRequestRow, "depart_at" | "return_at">): MergePreview | null {
  // The server's verdict wins (REQ §13.108 e): a merge the TS twin refused but the server allows still gets the server's times.
  if (!preview || !server || (!preview.valid && !server.ok && !server.waivable)) return preview;
  if (!preview.valid) preview = { ...preview, valid: true, invalid: null };
  const returnSide = preview.boardLeg === "return" && !preview.swapped;
  const boardEta = returnSide ? (server.joinerReturnAt ?? preview.boardEta) : (server.joinerDepartAt ?? preview.boardEta);
  const requestedAt = returnSide ? request.return_at : request.depart_at;
  const timeChanges = !!boardEta && !!requestedAt && Math.round(Date.parse(boardEta) / 60_000) !== Math.round(Date.parse(requestedAt) / 60_000);
  return {
    ...preview,
    startsAt: server.newStartsAt ?? preview.startsAt,
    endsAt: server.newEndsAt ?? preview.endsAt,
    boardEta, requestedAt: requestedAt ?? null, timeChanges,
    joinerOutAt: server.joinerDepartAt, joinerReturnAt: server.joinerReturnAt,
    chain: server.chain ?? null,
  };
}

/** The server's refusal codes (`_merge_error_code`) -> the `he.mergedRide.invalid` text. An unknown code gets the generic text. */
const MERGE_CODE_TEXT: Record<string, string> = {
  boards_at_end: he.mergedRide.invalid.boards_at_end,
  detour: he.mergedRide.invalid.detour_too_long,
  luggage: he.mergedRide.invalid.luggage_needs_large_trunk,
  seats: he.mergedRide.invalid.seats_full,
  private_car: he.mergedRide.invalid.private_car,
  turnaround: he.mergedRide.invalid.turnaround_conflict,
  already_on_ride: he.mergedRide.invalid.already_on_ride,
  leg_missing: he.mergedRide.invalid.leg_missing,
  series_day_leg: he.mergedRide.invalid.series_day_leg,
  window: he.mergedRide.invalid.window,
  time_far: he.mergedRide.invalid.time_far,
  window_locked: he.mergedRide.invalid.window_locked,
  maintenance: he.mergedRide.invalid.maintenance,
  fixed_hour: he.mergedRide.invalid.fixed_hour,
};

/** Hebrew reason for a `merge_preview` refusal `code` (REQ item 108 M1). */
export function mergeRefusalText(code: string | null | undefined, turnaroundSide?: "previous" | "next" | null, needs?: readonly ("large_trunk" | "tow_hitch")[]): string {
  if (code === "turnaround" && turnaroundSide === "previous") return he.mergedRide.invalid.turnaround_conflict_previous;
  // REQ §13.200: the `luggage` code covers both car needs - word it from the missing ones
  if (code === "luggage" && needs?.includes("tow_hitch")) {
    return needs.includes("large_trunk") ? he.mergedRide.invalid.luggage_and_tow : he.mergedRide.invalid.tow_needs_hitch;
  }
  return (code ? MERGE_CODE_TEXT[code] : undefined) ?? he.mergedRide.invalid.unknown;
}

/**
 * REQ item 108 (M1): whether one leg's merge is allowed. The server's `merge_preview` decides;
 * the TS twin's verdict is only the fallback when the preview request itself failed.
 * `loading` = no verdict yet (offer nothing), `source` says who refused.
 */
export type MergeVerdict =
  | { status: "loading" }
  /**
   * `waivable`: allowed, but only after the Sadran accepts a car without a large trunk for a large-luggage request (REQ §13.111 a);
   * `longDetour`: allowed after the Sadran accepts the long detour (REQ §13.175 a);
   * `tight`: a stop's stated hour moves - only said ("לו״ז צפוף", REQ item 246 g).
   */
  | { status: "ok"; waivable?: boolean; needs?: ("large_trunk" | "tow_hitch")[]; longDetour?: LongDetour; timeFar?: TimeFar; tight?: boolean }
  | { status: "refused"; message: string; code: string | null; source: "server" | "twin" };

/** What `useQuery` says about one `merge_preview` call (a subset, so tests need no React). */
export interface MergePreviewState {
  data: ServerMergePreview | null | undefined;
  isError: boolean;
}

/**
 * The verdict for one merge choice made of one or more `merge_preview` calls (a connected pair's
 * "both" joins one leg on each of two rides - every ride must accept). A refusal wins over a pending
 * call; a failed (or unreadable) call falls back to `twinInvalid` for that call.
 */
export function mergeVerdict(states: readonly MergePreviewState[], twinInvalid: MergeInvalid | null): MergeVerdict {
  let loading = false;
  let waivable = false;
  const needs = new Set<"large_trunk" | "tow_hitch">();
  let longDetour: LongDetour | undefined;
  let timeFar: TimeFar | undefined;
  let tight = false;
  for (const state of states) {
    if (state.data) {
      if (state.data.tight) tight = true;
      if (state.data.timeFar && (state.data.ok || state.data.waivable)) timeFar ??= state.data.timeFar;
      if (!state.data.ok && state.data.waivable) {
        if (state.data.luggageWaivable ?? !state.data.longDetour) { waivable = true; for (const need of state.data.needs ?? []) needs.add(need); }
        if (state.data.longDetour) longDetour ??= state.data.longDetour;
      } else if (!state.data.ok) return { status: "refused", message: mergeRefusalText(state.data.code, state.data.turnaroundSide, state.data.needs), code: state.data.code, source: "server" };
    } else if (state.isError || state.data === null) {
      if (twinInvalid) return { status: "refused", message: he.mergedRide.invalid[twinInvalid], code: twinInvalid, source: "twin" };
    } else {
      loading = true;
    }
  }
  if (loading) return { status: "loading" };
  return { status: "ok", ...(waivable ? { waivable: true, ...(needs.size > 0 ? { needs: [...needs] } : {}) } : {}), ...(longDetour ? { longDetour } : {}), ...(timeFar ? { timeFar } : {}), ...(tight ? { tight } : {}) };
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

export function mergeWaitChoice(
  server: ServerMergePreview | null | undefined,
  request: Pick<WeekRequestRow, "depart_at" | "return_at" | "flex_depart_late" | "flex_return_early">,
  leg: MergeLeg,
): MergeWaitChoice | null {
  const wait = server?.waitWindow;
  if (!server || !wait) return null;
  const minutes = (later: string, earlier: string) => (Date.parse(later) - Date.parse(earlier)) / 60_000;
  if (wait.endsAt && leg !== "out" && server.joinerReturnAt && request.return_at) {
    const early = parseFlexInterval(request.flex_return_early);
    if (early !== "day" && minutes(request.return_at, server.joinerReturnAt) > early) {
      return { side: "return", eta: server.joinerReturnAt, wanted: request.return_at, startsAt: null, endsAt: wait.endsAt };
    }
  }
  if (wait.startsAt && leg !== "return" && server.joinerDepartAt && request.depart_at) {
    const late = parseFlexInterval(request.flex_depart_late);
    if (late !== "day" && minutes(server.joinerDepartAt, request.depart_at) > late) {
      return { side: "out", eta: server.joinerDepartAt, wanted: request.depart_at, startsAt: wait.startsAt, endsAt: null };
    }
  }
  return null;
}
