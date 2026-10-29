// REQ §13.161 (a, d): what each request asked for versus what the ride(s) gave it.
// Pure: no React, Supabase or i18n. Used by the board (delta line on ride blocks / list cards)
// and by the change log screen. Replaces `deviations/requestDeviations.ts`.
import { parseFlexInterval } from "@/features/solverBridge/buildSolverInput";
import { parseRideRoute, type RoutePoint } from "@/lib/rideRoute";
import { peopleOf } from "@/features/rides/ridePeople";

import type { BoardRide, ProposalRow, WeekRequestRow } from "./api";
import { withinFlex } from "./board/geometry";
import { servedOf, type ServedEntry } from "../rides/servedOf";

export type DeltaAnchor = "depart" | "return";
export type ConsentState = "none" | "draft" | "sent" | "agreed";
export type DeltaState = "placed" | "unplaced" | "denied" | "external" | "cancelled";

/** One requested time versus the time the request got. */
export interface TimeDelta {
  anchor: DeltaAnchor;
  /** Instants (ISO). */
  asked: string;
  got: string;
  /** Signed minutes, `got - asked`. */
  shiftMinutes: number;
  /** The move exceeds the request's flexibility on that side (measured from the original time). */
  beyondFlex: boolean;
  rideId: string;
  /** `got` is the guest's stop ETA on a merged ride, not the ride's own start/end. */
  viaStop: boolean;
}

export type PlaceKind = "origin" | "destination" | "stops";
export interface PlaceDelta {
  kind: PlaceKind;
  /** Place names; for `stops` a comma-joined list. */
  asked: string;
  got: string;
  rideId: string;
}

/** Places the member asked for, when the baseline is known (a later migration stores it; until then the request row itself). */
export interface RequestedPlaces {
  originName?: string | null;
  destinationName?: string | null;
  /** Out-leg stop names, in order. */
  outStops?: readonly string[];
  returnStops?: readonly string[];
}

export interface RequestDelta {
  requestId: string;
  requesterName: string | null;
  state: DeltaState;
  rideIds: string[];
  depart: TimeDelta | null;
  return: TimeDelta | null;
  places: PlaceDelta[];
  /** Names on the ride that the request did not bring / names the request brought that are not on the ride. */
  peopleAdded: string[];
  peopleMissing: string[];
  /** Merged in as a guest: the ride's driver (or base requester) it rides with. */
  ridesWith: string | null;
  /** Preferred car id versus the car it got; log only, never beyond flexibility. */
  car: { askedCarId: string; gotCarId: string } | null;
  consent: ConsentState;
  /** Hours beyond flexibility, a changed place, or a changed set of people (the board's delta line). */
  beyondFlex: boolean;
  /** Any difference at all, flexibility ignored (the change log with its filter off). */
  anyDifference: boolean;
}

export interface RequestDeltaOptions {
  requestedPlaces?: RequestedPlaces;
  /** Name of the department home, for a request with no explicit origin. */
  homeName?: string | null;
}

type ProposalLike = Pick<ProposalRow, "request_id" | "status" | "updated_at">;

export function consentOf(requestId: string, proposals: readonly ProposalLike[]): ConsentState {
  const mine = proposals.filter((p) => p.request_id === requestId);
  if (mine.some((p) => p.status === "sent")) return "sent";
  if (mine.some((p) => p.status === "draft")) return "draft";
  if (mine.some((p) => p.status === "accepted" || p.status === "applied")) return "agreed";
  return "none";
}

const minutesBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 60_000);
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function baseEntry(ride: BoardRide): ServedEntry | undefined {
  const served = servedOf(ride);
  return served.find((entry) => entry.role === "driver") ?? served[0];
}

function timeDelta(request: WeekRequestRow, anchor: DeltaAnchor, asked: string, got: string, rideId: string, viaStop: boolean): TimeDelta {
  const shiftMinutes = minutesBetween(asked, got);
  const early = parseFlexInterval(anchor === "depart" ? request.flex_depart_early : request.flex_return_early);
  const late = parseFlexInterval(anchor === "depart" ? request.flex_depart_late : request.flex_return_late);
  return { anchor, asked, got, shiftMinutes, beyondFlex: !withinFlex(shiftMinutes, early, late), rideId, viaStop };
}

function stopEta(points: readonly RoutePoint[], requestId: string, kind: RoutePoint["kind"], leg: RoutePoint["leg"]): string | null {
  return points.find((p) => p.requestId === requestId && p.kind === kind && p.leg === leg)?.eta ?? null;
}

/** The request's own people (requester, companions, named children) by display name. */
function ownPeople(request: WeekRequestRow): string[] {
  return [request.requester_full_name, ...(request.companions ?? []).map((c) => c.name), ...(request.childNames ?? [])]
    .map((name) => name?.trim() ?? "").filter(Boolean);
}

function askedPlaces(request: WeekRequestRow, options: RequestDeltaOptions) {
  const p = options.requestedPlaces;
  const active = (leg: "out" | "return") => (request.stops ?? [])
    .filter((stop) => stop.leg === leg && (stop.active ?? true) && (leg === "out" || request.return_at != null))
    .sort((a, b) => a.position - b.position)
    .map((stop) => stop.place?.name ?? stop.place_text ?? "").filter(Boolean);
  return {
    origin: p?.originName ?? request.origin_resolved_name ?? request.origin_text ?? options.homeName ?? null,
    destination: p?.destinationName ?? request.destination_resolved_name ?? request.destination_text ?? null,
    outStops: p?.outStops ?? active("out"),
    returnStops: p?.returnStops ?? active("return"),
  };
}

/**
 * Requested versus got for one request. "Requested" is `original_depart_at` / `original_return_at`
 * (the member's last submitted times), falling back to the current ones. Flexibility is measured from
 * those originals, so a shift the Sadran already applied stays visible.
 *
 * Which ride time answers which asked time (same rule as the board's `requestWithinFlex`):
 * departure vs the ride's start (or the guest's boarding ETA on a merged ride); return vs the ride's
 * end (the guest's alighting ETA), except a separate pickup leg, judged by its start, and a chauffeur
 * pickup, judged by its end.
 */
export function requestDelta(
  request: WeekRequestRow,
  rides: readonly BoardRide[],
  proposals: readonly ProposalLike[] = [],
  options: RequestDeltaOptions = {},
): RequestDelta {
  const links = rides.filter((ride) => ride.id && ride.status !== "cancelled")
    .flatMap((ride) => servedOf(ride).filter((entry) => entry.request_id === request.id).map((entry) => ({ ride, entry })));
  const askedDepart = request.original_depart_at ?? request.depart_at;
  const askedReturn = request.original_return_at ?? request.return_at;
  const oneWayFrom = request.trip_shape === "one_way_from";
  const asked = askedPlaces(request, options);

  let depart: TimeDelta | null = null;
  let ret: TimeDelta | null = null;
  const places: PlaceDelta[] = [];
  const added = new Set<string>();
  const missing = new Set<string>();
  let ridesWith: string | null = null;
  let car: RequestDelta["car"] = null;
  const mine = ownPeople(request);

  for (const { ride, entry } of links) {
    const rideId = ride.id as string;
    const points = parseRideRoute(ride.route);
    const guest = baseEntry(ride)?.request_id !== request.id;
    if (guest) ridesWith = ride.driver_name ?? baseEntry(ride)?.requester ?? null;

    const wantsOut = (entry.leg === "out" || entry.leg === "both") && !oneWayFrom && !!askedDepart;
    if (wantsOut && ride.starts_at && !depart) {
      const eta = guest ? stopEta(points, request.id, "board", "out") : null;
      depart = timeDelta(request, "depart", askedDepart as string, eta ?? ride.starts_at, rideId, !!eta);
    }
    const wantsReturn = (entry.leg === "return" || entry.leg === "both") && !!askedReturn;
    if (wantsReturn && !ret) {
      const alight = guest ? stopEta(points, request.id, "alight", "return") : null;
      const separatePickup = entry.leg === "return" && !oneWayFrom;
      const rideTime = separatePickup && !(ride.is_chauffeur || entry.car_mode === "chauffeur") ? ride.starts_at : ride.ends_at;
      const got = alight ?? rideTime;
      if (got) ret = timeDelta(request, "return", askedReturn as string, got, rideId, !!alight);
    }

    if (request.preferred_car_id && ride.car_id && ride.car_id !== request.preferred_car_id && !car) {
      car = { askedCarId: request.preferred_car_id, gotCarId: ride.car_id };
    }

    // People: the ride's list versus the request's own people.
    const onRide = peopleOf(ride);
    const rideNames = onRide.map((person) => person.display_name.trim()).filter(Boolean);
    if (!guest) {
      for (const person of onRide) {
        if (person.source === "driver") continue;
        const name = person.display_name.trim();
        if (name && person.request_id !== request.id && !mine.some((own) => sameName(own, name))) added.add(name);
      }
      if (onRide.length) for (const name of mine) if (!rideNames.some((n) => sameName(n, name))) missing.add(name);
    }

    // Places (route-based; a chauffeur ride's route starts at the car, not at the member).
    const own = guest || !(ride.is_chauffeur || entry.car_mode === "chauffeur");
    if (points.length && own) {
      const originPoint = guest ? points.find((p) => p.requestId === request.id && p.kind === "board" && p.leg === "out")
        : points.find((p) => p.kind === "origin" && p.leg === "out");
      const destPoint = guest ? points.find((p) => p.requestId === request.id && p.kind === "alight" && p.leg === "out")
        : [...points].reverse().find((p) => p.kind === "destination" && p.leg === "out");
      if (asked.origin && originPoint?.name && !sameName(asked.origin, originPoint.name)) places.push({ kind: "origin", asked: asked.origin, got: originPoint.name, rideId });
      if (asked.destination && destPoint?.name && !sameName(asked.destination, destPoint.name)) places.push({ kind: "destination", asked: asked.destination, got: destPoint.name, rideId });
      const gotStops = (leg: "out" | "return") => points.filter((p) => p.kind === "stop" && p.leg === leg && (p.requestId === request.id || p.requestId == null)).map((p) => p.name);
      if (!guest && points.some((p) => p.kind === "stop" || p.requestId === request.id)) {
        const out = gotStops("out");
        if (out.join("|") !== asked.outStops.join("|")) places.push({ kind: "stops", asked: asked.outStops.join(", "), got: out.join(", "), rideId });
      }
    }
  }

  const state: DeltaState = request.status === "denied" ? "denied" : request.status === "external" ? "external"
    : request.status === "cancelled" ? "cancelled" : links.length ? "placed" : "unplaced";
  const peopleAdded = [...added];
  const peopleMissing = [...missing];
  const beyondFlex = !!depart?.beyondFlex || !!ret?.beyondFlex || places.length > 0 || peopleAdded.length > 0 || peopleMissing.length > 0 || ridesWith != null;
  const anyDifference = beyondFlex || !!depart?.shiftMinutes || !!ret?.shiftMinutes || car != null;
  return {
    requestId: request.id, requesterName: request.requester_full_name, state, rideIds: links.map(({ ride }) => ride.id as string),
    depart, return: ret, places, peopleAdded, peopleMissing, ridesWith, car, consent: consentOf(request.id, proposals), beyondFlex, anyDifference,
  };
}

/** Deltas of every live request of the week (drafts and withdrawn requests excluded), keyed by request id. */
export function requestDeltas(
  requests: readonly WeekRequestRow[],
  rides: readonly BoardRide[],
  proposals: readonly ProposalLike[] = [],
  options: RequestDeltaOptions = {},
): Map<string, RequestDelta> {
  const result = new Map<string, RequestDelta>();
  for (const request of requests) {
    if (request.status === "draft" || request.status === "withdrawn") continue;
    result.set(request.id, requestDelta(request, rides, proposals, options));
  }
  return result;
}

/** What one ride block / list card shows: only the beyond-flexibility parts. `null` = nothing to show. */
export interface RideDeltaView {
  /** Old and new time of the ride's start/end; a side is `null` when the ride does not carry that anchor. */
  hours: { askedStart: string | null; askedEnd: string | null; gotStart: string | null; gotEnd: string | null } | null;
  places: { kind: PlaceKind; asked: string; got: string }[];
  added: string[];
  missing: string[];
  consent: ConsentState;
}

/** The delta line of a ride: the base request's differences plus the people merged into it. */
export function rideDeltaView(ride: BoardRide, deltas: ReadonlyMap<string, RequestDelta>): RideDeltaView | null {
  const base = baseEntry(ride);
  const delta = base?.request_id ? deltas.get(base.request_id) : undefined;
  if (!delta || !ride.id) return null;
  const dep = delta.depart?.rideId === ride.id && delta.depart.beyondFlex ? delta.depart : null;
  const ret = delta.return?.rideId === ride.id && delta.return.beyondFlex ? delta.return : null;
  const places = delta.places.filter((p) => p.rideId === ride.id).map(({ kind, asked, got }) => ({ kind, asked, got }));
  if (!dep && !ret && !places.length && !delta.peopleAdded.length && !delta.peopleMissing.length) return null;
  const departHere = delta.depart?.rideId === ride.id ? delta.depart : null;
  const returnHere = delta.return?.rideId === ride.id ? delta.return : null;
  return {
    hours: dep || ret ? {
      askedStart: departHere?.asked ?? null, gotStart: departHere?.got ?? null,
      askedEnd: returnHere?.asked ?? null, gotEnd: returnHere?.got ?? null,
    } : null,
    places, added: delta.peopleAdded, missing: delta.peopleMissing, consent: delta.consent,
  };
}
