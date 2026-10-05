/**
 * Pure drag/drop validity logic for the board (extracted from `BoardScreen.tsx`,
 * docs/REFACTOR_PLAN_2026-09-11.md seam E1(c)). No React, no Supabase — every
 * closure the component used to read (rides, requests, cars, maintenance
 * blocks, seat configs, the currently selected day, the chauffeur-dwell
 * setting, the unmet-request list) is passed in explicitly via
 * `BoardDropContext`. Behaviour is unchanged; this is a mechanical hoist.
 */
import { fromZonedTime } from "date-fns-tz";

import { formatMinutes } from "@/components/timeField15Format";
import { TZ, dateKey } from "@/lib/time";
import type { Car } from "@/features/fleet/api";

import { servedOf } from "../applySolve";
import { isReservation } from "@/features/rides/servedOf";
import { slotToIso, wouldOverlap } from "./geometry";
import { defaultMergeLeg, mergeInvalidReason, previewMerge, type MergeLeg, type MergeRouteContext } from "./mergeProposal";
import { unmetItemId } from "./unmetLegs";
import { requestStart, requestWindow, requesterDrives, standaloneChauffeurWindow, tripTypeOf } from "./phantomLanes";
import type { UnmetListItem } from "./components/UnmetList";

import type { BoardRide, MaintenanceBlockRow, WeekRequestRow } from "../api";
import type { Window } from "@/solver";

export interface SeatConfig {
  adults: number;
  child_seats: number;
  boosters: number;
}

export interface SeatNeed {
  adults: number;
  childSeats: number;
  boosters: number;
}

/** Everything the drop-validity functions below used to read off `BoardScreen`'s closure. */
export interface BoardDropContext {
  rides: BoardRide[];
  requests: WeekRequestRow[];
  cars: Car[];
  maintenanceBlocks: MaintenanceBlockRow[];
  seatConfigsByCarId: Map<string, SeatConfig[]>;
  unmetItems: UnmetListItem[];
  selectedDay: string;
  chauffeurDwellMinutes: number;
  /**
   * Per car, windows where the car is away from its base (REQUIREMENTS §13.93;
   * `board/geometry.ts`'s `scanBoardConflicts` — same data the grid's "away" band draws).
   * Omit to skip the origin check (e.g. a context built before `conflictScan` is ready).
   */
  awayByCarId?: Map<string, { locationId: string; window: Window }[]>;
  /** Needed to convert `awayByCarId`'s slot-index windows into the ISO timestamps `carLocationAt` compares against. */
  weekStartMs?: number;
  /** Each car's own base (REQUIREMENTS §13.93), already defaulted to the department home by the caller. */
  carBaseLocationId?: Map<string, string>;
  /** The department home — the implicit origin of a request with no `origin_id` of its own. */
  homeDestinationId?: string;
  /**
   * REQ §13.94 (G10): travel data for the merged-ride preview. A merge keeps the host's start and
   * grows its end only by the added driving; without it the preview is the host's own window.
   */
  route?: MergeRouteContext;
}

/** The window of `host` once `request` joins (REQ §13.94/§13.95): start earlier by the added out-leg driving, end later by the added return-leg driving. */
export function mergedHostWindow(ctx: BoardDropContext, host: BoardRide, request: WeekRequestRow | undefined, leg: MergeLeg): { startsAt: string; endsAt: string } | null {
  if (!host.starts_at || !host.ends_at) return null;
  const preview = ctx.route && request ? previewMerge(host, request, leg, ctx.route) : null;
  return { startsAt: preview?.startsAt ?? host.starts_at, endsAt: preview?.endsAt ?? host.ends_at };
}

/**
 * Where `carId` is at `atIso` (REQUIREMENTS §13.93): inside one of its away windows, that
 * window's location; otherwise its own base (`carBaseLocationId`, already defaulted to home by
 * the caller). `null` when the context wasn't built with enough data to know (skips the check).
 */
export function carLocationAt(ctx: BoardDropContext, carId: string, atIso: string): string | null {
  if (ctx.weekStartMs == null) return null;
  const at = Date.parse(atIso);
  const away = (ctx.awayByCarId?.get(carId) ?? []).find((w) => {
    const start = Date.parse(slotToIso(w.window.start, ctx.weekStartMs as number));
    const end = Date.parse(slotToIso(w.window.end, ctx.weekStartMs as number));
    return start <= at && at < end;
  });
  if (away) return away.locationId;
  return ctx.carBaseLocationId?.get(carId) ?? ctx.homeDestinationId ?? null;
}

export function passengersOf(ride: BoardRide): SeatNeed {
  const served = servedOf(ride);
  return served.reduce(
    (acc, s) => ({ adults: acc.adults + s.adults, childSeats: acc.childSeats + s.child_seats, boosters: acc.boosters + s.boosters }),
    { adults: served.length && !served.some((entry) => entry.role === "driver") ? 1 : 0, childSeats: 0, boosters: 0 },
  );
}

/** Does any of `carId`'s seat configurations fit `need`? No configs on record -> don't block (unknown, not invalid). */
export function seatsFit(ctx: BoardDropContext, carId: string, need: SeatNeed): boolean {
  const configs = ctx.seatConfigsByCarId.get(carId) ?? [];
  if (configs.length === 0) return true;
  return configs.some((c) => c.adults >= need.adults && c.child_seats >= need.childSeats && c.boosters >= need.boosters);
}

/**
 * Maintenance/active-status only — **not** location-aware (REQUIREMENTS §13.93: a Sadran
 * manual ride move is always allowed regardless of where the car currently is; it produces a
 * chain-break warning afterwards instead of being blocked, SOLVER.md §1.3a `chainBreaks()`).
 * The origin-at-this-time check for a genuinely new placement lives in `isUnmetDropValid`
 * (`carLocationAt`) — only an *unmet request* card is location-gated on drop.
 */
export function unavailable(ctx: BoardDropContext, carId: string, startsAt: string, endsAt: string): boolean {
  if (ctx.cars.find((car) => car.id === carId)?.status !== "active") return true;
  if (wouldOverlap({ startsAt, endsAt }, ctx.maintenanceBlocks.filter((block) => block.car_id === carId)
    .map((block) => ({ startsAt: block.starts_at, endsAt: block.ends_at })), 0)) return true;
  return false;
}

export function mergeCandidateForRide(ctx: BoardDropContext, rideId: string, carId: string, _startsAt: string, _endsAt: string, hostRideId?: string) {
  const source = ctx.rides.find((ride) => ride.id === rideId);
  if (!source?.needs_driver || !hostRideId) return null;
  const host = ctx.rides.find((ride) => ride.id !== rideId && ride.car_id === carId && ride.starts_at && ride.ends_at
    && ride.id === hostRideId && !!ride.driver_id && !ride.needs_driver && !isReservation(ride));
  const guest = source ? servedOf(source).find((entry) => entry.role === "driver") ?? servedOf(source)[0] : undefined;
  if (!source?.starts_at || !source.ends_at || !host?.starts_at || !host.ends_at || !guest) return null;
  const request = ctx.requests.find((request) => request.id === guest.request_id);
  const window = mergedHostWindow(ctx, host, request, guest.leg ?? (request ? defaultMergeLeg(request) : "both"));
  return window ? { host, source, request, window } : null;
}

/** Same conversion as `BoardScreen`'s own `dayStartIso` (kept there too, for grid-layout
 * arithmetic outside the drop-validity cluster) — duplicated rather than imported so this
 * module has no dependency back on the component. */
function dayStartIso(day: string): string {
  return fromZonedTime(`${day}T00:00:00`, TZ).toISOString();
}

/** Shared timestamp conversion for the current day and snapped preview/drop windows. */
export function minutesIso(ctx: Pick<BoardDropContext, "selectedDay">, minutes: number): string {
  const date = new Date(`${ctx.selectedDay}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Math.floor(minutes / 1440));
  const time = formatMinutes(((minutes % 1440) + 1440) % 1440);
  return fromZonedTime(`${date.toISOString().slice(0, 10)}T${time}:00`, TZ).toISOString();
}

/** Validate the live preview window, including phantom requests dragged into real cars. */
export function isDropTargetValid(ctx: BoardDropContext, rideId: string, carId: string, startMinutes: number, endMinutes: number, hostRideId?: string): boolean {
  if (carId.startsWith("phantom:")) return !rideId.startsWith("request:");
  if (rideId.startsWith("request:")) {
    const item = ctx.unmetItems.find((item) => unmetItemId(item) === rideId);
    return !!item && isUnmetDropValid(ctx, item, carId, startMinutes, hostRideId);
  }
  if (startMinutes < 0 || endMinutes > 1439 || endMinutes <= startMinutes || unavailable(ctx, carId, minutesIso(ctx, startMinutes), minutesIso(ctx, endMinutes))) return false;
  const ride = ctx.rides.find((r) => r.id === rideId);
  if (!ride?.starts_at || !ride.ends_at) return true;
  const merge = mergeCandidateForRide(ctx, rideId, carId, minutesIso(ctx, startMinutes), minutesIso(ctx, endMinutes), hostRideId);
  if (merge) {
    if (!merge.host.driver_id || merge.host.needs_driver || !merge.request || mergeInvalidReason(merge.host, merge.request, defaultMergeLeg(merge.request), ctx.route) || unavailable(ctx, carId, merge.window.startsAt, merge.window.endsAt)) return false;
    const hostNeed = passengersOf(merge.host);
    if (!seatsFit(ctx, carId, { adults: hostNeed.adults + merge.request.adults, childSeats: hostNeed.childSeats + merge.request.child_seats, boosters: hostNeed.boosters + merge.request.boosters })) return false;
    return !wouldOverlap(merge.window, ctx.rides.filter((other) => other.id !== rideId && other.id !== merge.host.id && other.car_id === carId && other.starts_at && other.ends_at)
      .map((other) => ({ startsAt: other.starts_at!, endsAt: other.ends_at! })), 0);
  }
  if (!seatsFit(ctx, carId, passengersOf(ride))) return false;
  return true;
}

/**
 * REQ §13.95 (H2): a הקפצה's second leg dropped on the car that already carries its other leg
 * becomes a connected pair driven by the requester (SQL connects it inside `edit_ride`). Between
 * the legs the car waits at the destination, so none of the "car must be at the origin" /
 * "wrap window" rules apply to that drop.
 */
export function connectsOtherLeg(ctx: Pick<BoardDropContext, "rides">, item: UnmetListItem, carId: string): boolean {
  if (!item.leg || tripTypeOf(item.request) !== "drop_off") return false;
  return ctx.rides.some((ride) => ride.car_id === carId && ride.status !== "cancelled"
    && servedOf(ride).some((entry) => entry.request_id === item.request.id));
}

export function unmetRequestPassengers(r: WeekRequestRow): SeatNeed {
  // The requester's own seat is counted in `adults` when they drive (round trip, one way); a
  // drop-off needs a separate driver seat.
  return { adults: r.adults + (requesterDrives(r) ? 0 : 1), childSeats: r.child_seats, boosters: r.boosters };
}

export function unmetCandidateWindow(ctx: BoardDropContext, item: UnmetListItem, minutes: number, standalone = false): { startsAt: string; endsAt: string } | null {
  const req = item.request;
  const passenger = requestWindow(req);
  // Only a drop-off (הקפצה) is a chauffeur ride with its own wider window; a one-way trip is
  // the requester driving departure -> departure + route minutes, a round trip its whole span.
  const chauffeur = standalone && tripTypeOf(req) === "drop_off";
  const original = chauffeur ? standaloneChauffeurWindow(req, ctx.chauffeurDwellMinutes) : passenger;
  if (!original || !passenger || !requestStart(req) || dateKey(new Date(requestStart(req)!)) !== ctx.selectedDay) return null;
  const duration = (Date.parse(original.endsAt) - Date.parse(original.startsAt)) / 60_000;
  const requestedMinutes = (Date.parse(passenger.startsAt) - Date.parse(dayStartIso(ctx.selectedDay))) / 60_000;
  if (Math.abs(minutes - requestedMinutes) <= 15) minutes = requestedMinutes;
  const start = minutes - (chauffeur && req.trip_shape === "one_way_from" ? (Date.parse(passenger.startsAt) - Date.parse(original.startsAt)) / 60_000 : 0);
  if (start < 0 || start + duration > 1439) return null;
  return { startsAt: minutesIso(ctx, start), endsAt: minutesIso(ctx, start + duration) };
}

export function unmetMergeHost(ctx: BoardDropContext, item: UnmetListItem, carId: string, _minutes: number, hostRideId?: string) {
  if (tripTypeOf(item.request) === "round_trip" || !hostRideId) return undefined;
  return ctx.rides.find((ride) => ride.id === hostRideId && ride.car_id === carId && !!ride.driver_id && !ride.needs_driver && !isReservation(ride));
}

export function unmetPreviewWindow(ctx: BoardDropContext, item: UnmetListItem, carId: string, minutes: number, hostRideId?: string) {
  const host = unmetMergeHost(ctx, item, carId, minutes, hostRideId);
  return host?.starts_at && host.ends_at
    ? mergedHostWindow(ctx, host, item.request, defaultMergeLeg(item.request))
    : unmetCandidateWindow(ctx, item, minutes, !connectsOtherLeg(ctx, item, carId));
}

/**
 * REQUIREMENTS §13.93 (ORIGINS_PLAN §5): an unmet request card may only be dropped on a car
 * that is actually at the request's own origin when it would depart — mirrors
 * `CarTimeline.isFree`'s own origin check (SOLVER.md §1.3a), reimplemented against the board's
 * already-fetched rides/away-windows rather than a full solver timeline. `null` from
 * `carLocationAt` (not enough data loaded yet) never blocks — same "skip, don't false-positive"
 * spirit as the rest of this module before `conflictScan` is ready.
 */
export function originMismatch(ctx: BoardDropContext, carId: string, originId: string, atIso: string): boolean {
  const location = carLocationAt(ctx, carId, atIso);
  return location != null && location !== originId;
}

/**
 * REQUIREMENTS §13.93: a request that leaves the car somewhere other than where it started
 * (today, only an explicit הלוך בלבד — `trip_type === 'one_way'`) may only be dropped where the
 * car's *next* scheduled ride on that car, if any, already starts at that same place — mirrors
 * `CarTimeline.isFree(..., endLocationId)`. No next ride at all never blocks (nothing to strand).
 */
export function strandsNextRide(ctx: BoardDropContext, carId: string, endLocationId: string, afterIso: string, excludeRideId?: string): boolean {
  const next = ctx.rides
    .filter((r) => r.id !== excludeRideId && !isReservation(r) && r.car_id === carId && r.starts_at && Date.parse(r.starts_at) >= Date.parse(afterIso))
    .sort((a, b) => Date.parse(a.starts_at as string) - Date.parse(b.starts_at as string))[0];
  return !!next && next.origin_id != null && next.origin_id !== endLocationId;
}

/** Includes the whole chauffeur return block or expanded host, using actual
 * overlap rather than rejecting coordinator-approved short turnaround gaps. */
export function isUnmetDropValid(ctx: BoardDropContext, item: UnmetListItem, carId: string, minutes: number, hostRideId?: string): boolean {
  const window = unmetPreviewWindow(ctx, item, carId, minutes, hostRideId);
  if (!window || carId.startsWith("phantom:") || unavailable(ctx, carId, window.startsAt, window.endsAt)) return false;
  const host = unmetMergeHost(ctx, item, carId, minutes, hostRideId);
  // A merge boards the guest *en route* (REQ §13.94): where the car is and where it ends are the
  // host's business, not the guest's origin/destination.
  const originId = item.request.origin_id ?? ctx.homeDestinationId;
  const connects = !host && connectsOtherLeg(ctx, item, carId);
  if (!host && !connects && originId && originMismatch(ctx, carId, originId, window.startsAt)) return false;
  if (!host && tripTypeOf(item.request) === "one_way" && item.request.destination_id
    && strandsNextRide(ctx, carId, item.request.destination_id, window.endsAt)) return false;
  if (host && (!host.driver_id || host.needs_driver)) return false;
  if (host && mergeInvalidReason(host, item.request, defaultMergeLeg(item.request), ctx.route)) return false;
  const need = host ? passengersOf(host) : { adults: 1, childSeats: 0, boosters: 0 };
  if (!seatsFit(ctx, carId, host || !(requesterDrives(item.request) || connects)
    ? { adults: need.adults + item.request.adults, childSeats: need.childSeats + item.request.child_seats, boosters: need.boosters + item.request.boosters }
    : unmetRequestPassengers(item.request))) return false;
  // Without a merge host, `others` is every ride already on the target car — a plain drop
  // still needs to fit into that car's existing schedule, not just clear maintenance blocks
  // (previously this branch short-circuited to valid and let the SQL reject the overlap,
  // showing a green target followed by an error toast).
  const others = ctx.rides.filter((ride) => ride.id !== host?.id && ride.car_id === carId && ride.starts_at && ride.ends_at)
    .map((ride) => ({ startsAt: ride.starts_at!, endsAt: ride.ends_at! }));
  return !wouldOverlap(window, others, 0);
}

export interface UnmetPlacement {
  originId: string;
  destinationId: string;
  /** The requester drives (round trip, one way) or nobody does yet (drop-off: a chauffeur ride awaiting a driver). */
  driverIsRequester: boolean;
  served: { role: "driver" | "passenger"; leg: "out" | "return" | "both"; car_mode: "keep" | "relay" | "chauffeur" };
}

/**
 * How an unmet request card dropped on `carId` becomes a ride, by the member-facing trip type
 * (REQ §13.93; replaces the old `trip_shape` + department-home placement):
 * - `round_trip`: origin = destination = the request's origin, requester drives, `keep`.
 * - `one_way` (הלוך בלבד): origin -> destination, requester drives, `relay` (the car stays there).
 * - `drop_off` (הקפצה): a chauffeur ride; the ride's origin/destination is where the car is at the
 *   window start. With pickup (round-trip shape) only the out leg is placed (the card is one
 *   whole request; the return leg stays to be placed afterwards).
 * `null` when a one-way request has no destination place (free text cannot be a ride's end).
 */
export function unmetPlacement(ctx: BoardDropContext, req: WeekRequestRow, carId: string, windowStartIso: string): UnmetPlacement | null {
  const home = ctx.homeDestinationId;
  const origin = req.origin_id ?? home;
  if (!origin) return null;
  const type = tripTypeOf(req);
  if (type === "round_trip") {
    return { originId: origin, destinationId: origin, driverIsRequester: true, served: { role: "driver", leg: "both", car_mode: "keep" } };
  }
  const leg = req.trip_shape === "one_way_from" ? "return" : "out";
  if (type === "one_way") {
    if (!req.destination_id) return null;
    return { originId: origin, destinationId: req.destination_id, driverIsRequester: true, served: { role: "driver", leg, car_mode: "relay" } };
  }
  const where = carLocationAt(ctx, carId, windowStartIso) ?? (leg === "return" ? req.destination_id : origin) ?? origin;
  return { originId: where, destinationId: where, driverIsRequester: false, served: { role: "passenger", leg, car_mode: "chauffeur" } };
}

/**
 * The `shift` proposal payload for an unmet drop that falls outside the request's flexibility:
 * the places always come from the request/placement, never the department home.
 */
export function unmetShiftPayload(req: WeekRequestRow, carId: string, window: { startsAt: string; endsAt: string }, placement: UnmetPlacement): Record<string, unknown> {
  const type = tripTypeOf(req);
  // A drop-off's ride places are where the car is, not the request's route: keep the request's own.
  const places: Record<string, string> = Object.fromEntries(Object.entries(type === "drop_off"
    ? { origin_id: req.origin_id, destination_id: req.destination_id }
    : { origin_id: placement.originId, destination_id: placement.destinationId }).filter(([, id]) => !!id)) as Record<string, string>;
  if (type === "round_trip") return { car_id: carId, depart_at: window.startsAt, return_at: window.endsAt, ...places };
  if (type === "one_way") return req.trip_shape === "one_way_from"
    ? { car_id: carId, return_at: window.endsAt, ...places }
    : { car_id: carId, depart_at: window.startsAt, ...places };
  return req.trip_shape === "one_way_from" ? { return_at: window.endsAt, ...places } : { depart_at: window.startsAt, ...places };
}
