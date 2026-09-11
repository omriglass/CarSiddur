/**
 * Pure drag/drop validity logic for the board (extracted from `BoardScreen.tsx`,
 * docs/REFACTOR_PLAN_2026-09-11.md seam E1(c)). No React, no Supabase — every
 * closure the component used to read (rides, requests, cars, maintenance
 * blocks, seat configs, the currently selected day, the chauffeur-dwell
 * setting, the unmet-request list) is passed in explicitly via
 * `BoardDropContext`. Behaviour is unchanged; this is a mechanical hoist.
 */
import { fromZonedTime } from "date-fns-tz";

import { formatMinutes } from "@/components/TimeField15";
import { TZ, dateKey } from "@/lib/time";
import type { Car } from "@/features/fleet/api";

import { servedOf } from "../applySolve";
import { wouldOverlap } from "./geometry";
import { expandedMergeWindow } from "./mergeWindow";
import { requestStart, requestWindow, standaloneChauffeurWindow } from "./phantomLanes";
import type { UnmetListItem } from "./components/UnmetList";

import type { BoardRide, MaintenanceBlockRow, WeekRequestRow } from "../api";

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

export function unavailable(ctx: BoardDropContext, carId: string, startsAt: string, endsAt: string): boolean {
  if (ctx.cars.find((car) => car.id === carId)?.status !== "active") return true;
  return wouldOverlap({ startsAt, endsAt }, ctx.maintenanceBlocks.filter((block) => block.car_id === carId)
    .map((block) => ({ startsAt: block.starts_at, endsAt: block.ends_at })), 0);
}

export function mergeCandidateForRide(ctx: BoardDropContext, rideId: string, carId: string, _startsAt: string, _endsAt: string, hostRideId?: string) {
  const source = ctx.rides.find((ride) => ride.id === rideId);
  if (!source?.needs_driver || !hostRideId) return null;
  const host = ctx.rides.find((ride) => ride.id !== rideId && ride.car_id === carId && ride.starts_at && ride.ends_at
    && ride.id === hostRideId && !!ride.driver_id && !ride.needs_driver);
  const guest = source ? servedOf(source).find((entry) => entry.role === "driver") ?? servedOf(source)[0] : undefined;
  if (!source?.starts_at || !source.ends_at || !host?.starts_at || !host.ends_at || !guest) return null;
  const request = ctx.requests.find((request) => request.id === guest.request_id);
  const window = source.needs_driver && request ? requestWindow(request) : { startsAt: source.starts_at, endsAt: source.ends_at };
  return window ? { host, source, request, window: expandedMergeWindow({ startsAt: host.starts_at, endsAt: host.ends_at }, window) } : null;
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
    const item = ctx.unmetItems.find((item) => `request:${item.request.id}` === rideId);
    return !!item && isUnmetDropValid(ctx, item, carId, startMinutes, hostRideId);
  }
  if (startMinutes < 0 || endMinutes > 1439 || endMinutes <= startMinutes || unavailable(ctx, carId, minutesIso(ctx, startMinutes), minutesIso(ctx, endMinutes))) return false;
  const ride = ctx.rides.find((r) => r.id === rideId);
  if (!ride?.starts_at || !ride.ends_at) return true;
  const merge = mergeCandidateForRide(ctx, rideId, carId, minutesIso(ctx, startMinutes), minutesIso(ctx, endMinutes), hostRideId);
  if (merge) {
    if (!merge.host.driver_id || merge.host.needs_driver || !merge.request || unavailable(ctx, carId, merge.window.startsAt, merge.window.endsAt)) return false;
    const hostNeed = passengersOf(merge.host);
    if (!seatsFit(ctx, carId, { adults: hostNeed.adults + merge.request.adults, childSeats: hostNeed.childSeats + merge.request.child_seats, boosters: hostNeed.boosters + merge.request.boosters })) return false;
    return !wouldOverlap(merge.window, ctx.rides.filter((other) => other.id !== rideId && other.id !== merge.host.id && other.car_id === carId && other.starts_at && other.ends_at)
      .map((other) => ({ startsAt: other.starts_at!, endsAt: other.ends_at! })), 0);
  }
  if (!seatsFit(ctx, carId, passengersOf(ride))) return false;
  return true;
}

export function unmetRequestPassengers(r: WeekRequestRow): SeatNeed {
  return { adults: r.adults + (r.trip_shape === "round_trip" ? 0 : 1), childSeats: r.child_seats, boosters: r.boosters };
}

export function unmetCandidateWindow(ctx: BoardDropContext, item: UnmetListItem, minutes: number, standalone = false): { startsAt: string; endsAt: string } | null {
  const req = item.request;
  const passenger = requestWindow(req);
  const original = standalone ? standaloneChauffeurWindow(req, ctx.chauffeurDwellMinutes) : passenger;
  if (!original || !passenger || !requestStart(req) || dateKey(new Date(requestStart(req)!)) !== ctx.selectedDay) return null;
  const duration = (Date.parse(original.endsAt) - Date.parse(original.startsAt)) / 60_000;
  const requestedMinutes = (Date.parse(passenger.startsAt) - Date.parse(dayStartIso(ctx.selectedDay))) / 60_000;
  if (Math.abs(minutes - requestedMinutes) <= 15) minutes = requestedMinutes;
  const start = minutes - (standalone && req.trip_shape === "one_way_from" ? (Date.parse(passenger.startsAt) - Date.parse(original.startsAt)) / 60_000 : 0);
  if (start < 0 || start + duration > 1439) return null;
  return { startsAt: minutesIso(ctx, start), endsAt: minutesIso(ctx, start + duration) };
}

export function unmetMergeHost(ctx: BoardDropContext, item: UnmetListItem, carId: string, _minutes: number, hostRideId?: string) {
  if (item.request.trip_shape === "round_trip" || !hostRideId) return undefined;
  return ctx.rides.find((ride) => ride.id === hostRideId && ride.car_id === carId && !!ride.driver_id && !ride.needs_driver);
}

export function unmetPreviewWindow(ctx: BoardDropContext, item: UnmetListItem, carId: string, minutes: number, hostRideId?: string) {
  const host = unmetMergeHost(ctx, item, carId, minutes, hostRideId);
  const passenger = requestWindow(item.request);
  return host?.starts_at && host.ends_at && passenger
    ? expandedMergeWindow({ startsAt: host.starts_at, endsAt: host.ends_at }, passenger)
    : unmetCandidateWindow(ctx, item, minutes, true);
}

/** Includes the whole chauffeur return block or expanded host, using actual
 * overlap rather than rejecting coordinator-approved short turnaround gaps. */
export function isUnmetDropValid(ctx: BoardDropContext, item: UnmetListItem, carId: string, minutes: number, hostRideId?: string): boolean {
  const window = unmetPreviewWindow(ctx, item, carId, minutes, hostRideId);
  if (!window || carId.startsWith("phantom:") || unavailable(ctx, carId, window.startsAt, window.endsAt)) return false;
  const host = unmetMergeHost(ctx, item, carId, minutes, hostRideId);
  if (host && (!host.driver_id || host.needs_driver)) return false;
  const need = host ? passengersOf(host) : { adults: 1, childSeats: 0, boosters: 0 };
  if (!seatsFit(ctx, carId, host || item.request.trip_shape !== "round_trip"
    ? { adults: need.adults + item.request.adults, childSeats: need.childSeats + item.request.child_seats, boosters: need.boosters + item.request.boosters }
    : unmetRequestPassengers(item.request))) return false;
  const others = ctx.rides.filter((ride) => ride.id !== host?.id && ride.car_id === carId && ride.starts_at && ride.ends_at)
    .map((ride) => ({ startsAt: ride.starts_at!, endsAt: ride.ends_at! }));
  return !host || !wouldOverlap(window, others, 0);
}
