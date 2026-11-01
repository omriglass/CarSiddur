// REQ §13.170: the WhatsApp text that asks "who can drive?" for a ride with no driver. Pure, unit tested.
import { formatDayMonth, weekdayLabel } from "@/lib/dayLabels";
import { tv, t } from "@/i18n/he";
import { parseRideRoute } from "@/lib/rideRoute";
import { dateKey, formatTime } from "@/lib/time";

import type { BoardRide } from "./api";
import { peopleOf } from "./ridePeople";
import { servedOf } from "./servedOf";

const DAY_MS = 86_400_000;
const SOURCE_ORDER = ["requester", "companion", "guest", "added", "child"];

/** "היום" / "מחר" / "ביום חמישי", with the date beyond the coming six days. */
export function driverWantedDay(startsAt: Date, now: Date): string {
  const days = Math.round((Date.parse(dateKey(startsAt)) - Date.parse(dateKey(now))) / DAY_MS);
  if (days === 0) return t("driverWanted.today");
  if (days === 1) return t("driverWanted.tomorrow");
  const day = weekdayLabel(startsAt);
  return days > 1 && days <= 6 ? tv("driverWanted.onDay", { day }) : tv("driverWanted.onDayDate", { day, date: formatDayMonth(startsAt) });
}

/** "אותי ואת דנה" / "את דנה, את רון ואת שי" — the viewer first when riding. */
function whoLine(names: readonly { id: string | null; name: string }[], viewerId: string | undefined): string {
  const mine = names.some((person) => !!viewerId && person.id === viewerId);
  const parts = [
    ...(mine ? [t("driverWanted.me")] : []),
    ...names.filter((person) => !viewerId || person.id !== viewerId).map((person) => tv("driverWanted.other", { name: person.name })),
  ];
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} ${t("driverWanted.and")}${parts[parts.length - 1]}`;
}

/** The ride's riders, the requester first and children last (the people list itself is ordered by name). */
export function driverWantedRiders(ride: BoardRide): { id: string | null; name: string }[] {
  return peopleOf(ride).filter((person) => person.source !== "driver")
    .sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source))
    .map((person) => ({ id: person.person_id, name: person.display_name }));
}

export function driverWantedText(ride: BoardRide, viewerId: string | undefined, now: Date, link: string): string {
  const riders = driverWantedRiders(ride);
  const served = servedOf(ride).filter((entry) => entry.role !== "driver");
  const first = served[0];
  // Same reading as the ride's label (rideLabel.ts): a return leg, or an out leg starting away from the car, is a pickup.
  const pickupFromOrigin = !!first && first.leg !== "return" && !!ride.origin_id && !!first.origin_id && first.origin_id !== ride.origin_id;
  const pickup = !!first && (first.leg === "return" || pickupFromOrigin);
  const placeName = (pickupFromOrigin ? first?.origin_name : first?.destination) ?? ride.destination_name ?? "";
  const startsAt = new Date(ride.starts_at ?? "");
  // R17U1: a pickup says when the rider is picked up (the route's estimate), with the driver's start in brackets.
  const pickupEta = pickup && first
    ? parseRideRoute(ride.route).find((point) => point.requestId === first.request_id && point.kind === "origin"
        && point.leg === (first.leg === "return" ? "return" : "out"))?.eta ?? null
    : null;
  const who = whoLine(riders.length ? riders : served.map((entry) => ({ id: null, name: entry.requester ?? "" })).filter((r) => r.name), viewerId);
  const vars = {
    who,
    day: driverWantedDay(startsAt, now),
    place: tv(pickup ? "driverWanted.from" : "route.to", { destination: placeName }),
    time: formatTime(startsAt),
    link,
  };
  if (!pickup) return tv("driverWanted.textOut", vars);
  return pickupEta
    ? tv("driverWanted.textPickupAt", { ...vars, pickupTime: formatTime(new Date(pickupEta)) })
    : tv("driverWanted.textPickup", vars);
}

/**
 * REQ §13.174: the ride's driver when they are a volunteer — driving others, with no request of their own on it (the
 * SQL `release_ride_driver` / `take_over_ride_driver` rule). Only a volunteer may step down or be taken over from.
 */
export function volunteerDriverOf(ride: BoardRide): { id: string; name: string } | null {
  if (!ride.driver_id || ride.needs_driver || ride.status === "cancelled") return null;
  const served = servedOf(ride);
  if (!served.length || served.some((entry) => entry.role === "driver")) return null;
  return { id: ride.driver_id, name: ride.driver_name ?? "" };
}

/** REQ §13.170 (R17B1): the viewer is being driven on this ride (a rider of its chauffeur leg) — they cannot drive it. */
export function isDrivenOnRide(ride: BoardRide, viewerId: string | undefined): boolean {
  if (!viewerId) return false;
  const chauffeured = new Set(servedOf(ride).filter((entry) => entry.car_mode === "chauffeur").map((entry) => entry.request_id));
  return peopleOf(ride).some((person) => person.person_id === viewerId && !!person.request_id && chauffeured.has(person.request_id));
}
