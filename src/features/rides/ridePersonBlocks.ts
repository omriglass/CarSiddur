// RD1 (docs/TODO.md): the "פרטי הנסיעה" blocks of a shared ride - one per person who asked for something
// (a served request's requester, a driver with no request, a "+ נוסעים" row), each with their own request next
// to what the ride does. Pure (no React/Supabase); the component is `components/RidePersonBlocks.tsx`.
//
// Data sources: `v_board_rides.served[]` (route, stops, legs, seats, luggage) and `.people` (roles, companions,
// guests, added), `.route` (the ride's own via-places), `starts_at`. The requested hours, flexibility and the
// note to the Sadran are NOT in the views: only a caller that already loaded the request (the board's week
// requests, with `request_notes` applied) passes them as `requests`.
import { he, tv } from "@/i18n/he";
import { parseRideRoute, routeViaNames } from "@/lib/rideRoute";
import { routeLabel } from "@/lib/routeLabel";
import { formatTime } from "@/lib/time";

import { peopleOf, type RidePerson } from "./ridePeople";
import { entryCoversLeg, type ServedEntry } from "./servedOf";
import type { BoardRide } from "./api";

export type PersonBlockRole = "driver" | "rider" | "added";
export type PersonLeg = "out" | "return" | "both";

/** What a caller knows about one request beyond `served[]` (all optional). */
export interface RequestExtras {
  departAt?: string | null;
  returnAt?: string | null;
  /** Postgres `interval` text ("00:30:00", "1 day") or null. */
  flexDepartEarly?: string | null;
  flexDepartLate?: string | null;
  flexReturnEarly?: string | null;
  flexReturnLate?: string | null;
  /** Only where the viewer may already read it (`request_notes`, REQ §13.153). */
  note?: string | null;
}

export interface PersonBlock {
  key: string;
  name: string;
  role: PersonBlockRole;
  requestId: string | null;
  /** "מ… ל…" (+ stops); null for a person with no request of their own. */
  routeText: string | null;
  leg: PersonLeg | null;
  outStops: string[];
  returnStops: string[];
  departAt: string | null;
  returnAt: string | null;
  /** Minutes of flexibility per field, `null` unknown; 1440 = any time that day. */
  flex: { departEarly: number | null; departLate: number | null; returnEarly: number | null; returnLate: number | null } | null;
  seats: { adults: number; childSeats: number; boosters: number } | null;
  luggage: boolean;
  /** REQ §13.200: the request needs a towing car. */
  tow: boolean;
  /** Companions, named children, guests riding on this person's request. */
  withNames: string[];
  note: string | null;
  differs: string[];
}

/** Interval text -> minutes (`"00:30:00"` -> 30, `"1 day"` -> 1440, `"2 hours"` -> 120, `"15 min"` -> 15). */
export function intervalMinutes(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const text = raw.trim().toLowerCase();
  const hms = /^(\d+):(\d{2}):\d{2}$/.exec(text);
  if (hms) return Number(hms[1]) * 60 + Number(hms[2]);
  const day = /^(\d+)\s*days?$/.exec(text);
  if (day) return Number(day[1]) * 1440;
  const hour = /^(\d+)\s*hours?$/.exec(text);
  if (hour) return Number(hour[1]) * 60;
  const min = /^(\d+)\s*min/.exec(text);
  if (min) return Number(min[1]);
  return text === "0" ? 0 : null;
}

function flexOf(extras: RequestExtras | undefined): PersonBlock["flex"] {
  if (!extras) return null;
  const flex = {
    departEarly: intervalMinutes(extras.flexDepartEarly),
    departLate: intervalMinutes(extras.flexDepartLate),
    returnEarly: intervalMinutes(extras.flexReturnEarly),
    returnLate: intervalMinutes(extras.flexReturnLate),
  };
  return Object.values(flex).every((value) => !value) ? null : flex;
}

const SECONDARY: ReadonlySet<RidePerson["source"]> = new Set(["companion", "child", "guest"]);

function sameMinute(a: string, b: string): boolean {
  return Math.round(Date.parse(a) / 60000) === Math.round(Date.parse(b) / 60000);
}

function uniq(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))];
}

/** True when the ride deserves the per-person layout (REQ RD1): more than one request, or companions/guests/added people. */
export function needsPersonBlocks(ride: Pick<BoardRide, "people">, served: readonly ServedEntry[]): boolean {
  if (served.length > 1) return true;
  return peopleOf(ride).some((person) => person.source === "companion" || person.source === "guest" || person.source === "added");
}

export interface BuildPersonBlocksInput {
  ride: Pick<BoardRide, "people" | "route" | "starts_at" | "driver_id" | "driver_name" | "needs_driver">;
  served: readonly ServedEntry[];
  homeDestinationId?: string | null;
  /** Per request id. */
  requests?: ReadonlyMap<string, RequestExtras>;
}

export function buildPersonBlocks({ ride, served, homeDestinationId, requests }: BuildPersonBlocksInput): PersonBlock[] {
  const people = peopleOf(ride);
  const routePoints = parseRideRoute(ride.route);
  const blocks: PersonBlock[] = [];
  const driverFirst = [...served].sort((a, b) => Number(b.role === "driver") - Number(a.role === "driver"));

  for (const entry of driverFirst) {
    const extras = entry.request_id ? requests?.get(entry.request_id) : undefined;
    const parsedStops = (entry.stops ?? []).filter((stop) => stop.active !== false);
    const outStops = parsedStops.filter((stop) => stop.leg === "out").map((stop) => stop.name);
    const returnStops = parsedStops.filter((stop) => stop.leg === "return").map((stop) => stop.name);
    const origin = entry.origin_name ?? entry.origin_text ?? "";
    const destination = entry.destination ?? "";
    const originIsHome = !origin || (!!entry.origin_id && !!homeDestinationId && entry.origin_id === homeDestinationId);
    const withNames = uniq([
      ...people.filter((person) => person.request_id === entry.request_id && SECONDARY.has(person.source)).map((person) => person.display_name.trim()),
      ...(entry.guest_passenger_names ?? []),
      ...(entry.companions ?? []).map((companion) => companion.name),
      ...(entry.childNames ?? []),
    ]);
    const differs: string[] = [];
    const rideLeg = entry.ride_leg ?? entry.leg;
    if (extras?.departAt && ride.starts_at && entryCoversLeg({ leg: rideLeg }, "out") && !sameMinute(extras.departAt, ride.starts_at)) {
      differs.push(tv("rideDetail.person.differsStart", {
        asked: formatTime(new Date(extras.departAt)),
        ride: formatTime(new Date(ride.starts_at)),
      }));
    }
    const own = new Set([origin, destination, ...outStops, ...returnStops].filter(Boolean));
    // The person's own boarding/alighting points are theirs, not a difference.
    const others = routePoints.filter((point) => !entry.request_id || point.requestId !== entry.request_id);
    const otherVia = routeViaNames(others);
    const extraVia = uniq([...otherVia.out, ...otherVia.return]).filter((name) => !own.has(name));
    if (extraVia.length && destination) differs.push(tv("rideDetail.person.differsRoute", { places: extraVia.join(", ") }));

    blocks.push({
      key: entry.request_id ?? `served:${blocks.length}`,
      name: entry.requester?.trim() || people.find((person) => person.request_id === entry.request_id && !SECONDARY.has(person.source))?.display_name.trim() || "",
      role: entry.role === "driver" ? "driver" : "rider",
      requestId: entry.request_id,
      routeText: destination ? routeLabel({ destination, origin, originIsHome, stops: outStops }) : null,
      leg: entry.leg,
      outStops,
      returnStops,
      departAt: extras?.departAt ?? null,
      returnAt: extras?.returnAt ?? null,
      flex: flexOf(extras),
      seats: { adults: entry.adults, childSeats: entry.child_seats, boosters: entry.boosters },
      luggage: !!entry.luggage,
      tow: !!entry.tow_hitch,
      withNames,
      note: extras?.note?.trim() || null,
      differs,
    });
  }

  const requestIds = new Set(served.map((entry) => entry.request_id));
  // A volunteer / chauffeur driver who has no request on this ride.
  const driverRow = people.find((person) => person.source === "driver");
  if (driverRow && !(driverRow.request_id && requestIds.has(driverRow.request_id)) && !blocks.some((block) => block.role === "driver")) {
    blocks.unshift(emptyBlock(driverRow.key, driverRow.display_name.trim(), "driver"));
  }
  for (const person of people.filter((p) => p.source === "added")) {
    const leg = person.leg ?? null;
    blocks.push({ ...emptyBlock(person.key, person.display_name.trim(), "added"), leg });
  }
  return blocks.filter((block) => block.name !== "");
}

function emptyBlock(key: string, name: string, role: PersonBlockRole): PersonBlock {
  return {
    key, name, role, requestId: null, routeText: null, leg: null, outStops: [], returnStops: [], departAt: null, returnAt: null,
    flex: null, seats: null, luggage: false, tow: false, withNames: [], note: null, differs: [],
  };
}

/** "±½ ש׳" / "½ ש׳ מוקדם / ¼ ש׳ מאוחר" for one side's pair; "" when both are zero/unknown. */
export function flexPairText(early: number | null, late: number | null): string {
  const label = (minutes: number): string => {
    const key = minutes >= 1440 ? "any" : minutes >= 120 ? "120" : minutes >= 60 ? "60" : minutes >= 30 ? "30" : minutes >= 15 ? "15" : "0";
    return he.requestSentence.flexChip[key as keyof typeof he.requestSentence.flexChip];
  };
  const e = early ?? 0;
  const l = late ?? 0;
  if (!e && !l) return "";
  if (e === l) return tv("requestSentence.flexBrief", { amount: label(e) });
  return [e ? tv("requestSentence.flexBriefEarly", { amount: label(e) }) : "", l ? tv("requestSentence.flexBriefLate", { amount: label(l) }) : ""].filter(Boolean).join(" / ");
}
