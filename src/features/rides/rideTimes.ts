// SD1 (REQ item 256, owner 2026-11-18/19): the ride's time constraints in one picture. Builds, from the ride's
// route (`v_board_rides.route`, ~estimated hours), each person's part of it (`ride_stretches`) and their requests'
// stated hours, the two views of the Sadran's "פרטי הנסיעה" (יעדים tab):
//  * per person - one block per person (companions inside their requester's), a row where they get on and off,
//    what they asked ("ביקש/ה") beside what the ride does ("בפועל");
//  * per route - one card per place in driving order: the hour, who gets on/off, each stated hour at that place.
// Two kinds of trouble (owner 2026-11-19):
//  * definitely broken - two SET hours that cannot both hold (one person's leave-at after another's leave-at or
//    arrive-by further on, or the ride's own start); no estimate is involved;
//  * possibly broken - an ESTIMATE misses a stated hour (later than it with its flexibility) or comes within
//    `TIGHT_MINUTES` of an arrive-by. Estimates are only estimates: this is a heads-up, never a refusal.
// Pure: no React, no Supabase; returns data, the component words it.

import type { RouteLeg, RoutePoint } from "@/lib/rideRoute";

import type { RidePerson } from "./ridePeople";
import { intervalMinutes } from "./ridePersonBlocks";
import { baseRequestId, legPoints, LEGS, personSpan, stopRows, type RideStretches } from "./rideStretches";

/** An estimate within this many minutes of an arrive-by is "צפוף" (owner 2026-11-19). */
export const TIGHT_MINUTES = 10;
/** Flexibility of a day or more = any time (REQ §13.98). */
const ANY_TIME = 1440;
const MINUTE = 60_000;

/** The request columns this module reads (`WeekRequestRow` has them all). */
export interface RequestHours {
  id: string;
  trip_type?: string | null;
  depart_at?: string | null;
  return_at?: string | null;
  depart_anchor?: string | null;
  arrive_by?: string | null;
  return_anchor?: string | null;
  leave_dest_at?: string | null;
  flex_depart_early?: unknown;
  flex_depart_late?: unknown;
  flex_return_early?: unknown;
  flex_return_late?: unknown;
}

/** One stated hour at one place of the ride. `leave`: leave there at `at` (−early..+late); `arrive`: be there by `at` (+late). */
export interface Stated {
  id: string;
  leg: RouteLeg;
  position: number;
  anchor: "arrive" | "leave";
  at: string;
  early: number;
  late: number;
  /** The person whose hour it is; "" for the ride's own start. */
  name: string;
  /** The ride's own start (a set hour, the Sadran's), not a person's. */
  rideStart?: boolean;
}

export type Mark =
  | { kind: "ok" }
  | { kind: "tight"; minutes: number }
  | { kind: "late"; minutes: number }
  | { kind: "conflict" };

export interface Conflict { a: Stated; b: Stated }

/** The hour the ride does at a place: the set start, else the route's estimate. */
export interface Actual { at: string; estimate: boolean }

export type RowKind = "leave" | "board" | "arriveBy" | "alight" | "back";

export interface PersonRow {
  leg: RouteLeg;
  position: number;
  kind: RowKind;
  place: string;
  stated: Stated | null;
  actual: Actual | null;
  mark: Mark | null;
}

export interface PersonTimes {
  key: string;
  name: string;
  role: "driver" | "rider" | "added";
  legs: "out" | "return" | "both";
  withNames: string[];
  rows: PersonRow[];
  conflicts: Conflict[];
}

export interface PlaceTag { stated: Stated; mark: Mark }

export interface PlaceCard {
  leg: RouteLeg;
  position: number;
  first: boolean;
  name: string;
  isStop: boolean;
  actual: Actual | null;
  on: string[];
  off: string[];
  free: number | null;
  tags: PlaceTag[];
  conflicts: Conflict[];
}

export interface LegSpan { leg: RouteLeg; from: Actual | null; to: Actual | null }

export interface RideTimes {
  legs: LegSpan[];
  places: string[];
  people: PersonTimes[];
  route: PlaceCard[];
  /** Any definite conflict / possible break on the ride (for a header hint). */
  conflicts: Conflict[];
}

const SECONDARY = new Set<RidePerson["source"]>(["companion", "child", "guest"]);

function minutesOf(raw: unknown): number {
  const value = typeof raw === "number" ? raw : intervalMinutes(typeof raw === "string" ? raw : null);
  return value == null ? 0 : value;
}

function hasReturn(request: RequestHours): boolean {
  return !!request.return_at && request.trip_type !== "one_way";
}

/** The window the car may LEAVE a place in (leave-at), or the latest it may ARRIVE (arrive-by). */
function bounds(s: Stated): { lo: number; hi: number } {
  const at = Date.parse(s.at);
  const hi = s.late >= ANY_TIME ? Infinity : at + s.late * MINUTE;
  if (s.anchor === "arrive") return { lo: -Infinity, hi };
  return { lo: s.early >= ANY_TIME ? -Infinity : at - s.early * MINUTE, hi };
}

/** Event order along the ride: the way there before the way back, by position. */
function order(s: Pick<Stated, "leg" | "position">): number {
  return (s.leg === "out" ? 0 : 10_000) + s.position;
}

/**
 * Definite conflicts: a leave-at whose earliest hour is after the latest hour of a later (or the same) departure, or
 * of an arrival further on. An arrival at the same place may come before its departure, so it never conflicts there.
 */
export function definiteConflicts(stated: readonly Stated[]): Conflict[] {
  const out: Conflict[] = [];
  const seen = new Set<string>();
  for (const a of stated) {
    if (a.anchor !== "leave") continue;
    const lo = bounds(a).lo;
    if (lo === -Infinity) continue;
    for (const b of stated) {
      if (a === b) continue;
      const later = b.anchor === "leave" ? order(b) >= order(a) : order(b) > order(a);
      if (!later || bounds(b).hi >= lo) continue;
      const id = [a.id, b.id].sort().join("|");
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ a, b });
    }
  }
  return out;
}

/** An estimate against one stated hour (a set hour is judged only by `definiteConflicts`). */
export function estimateMark(s: Stated, actual: Actual | null): Mark {
  if (!actual?.estimate) return { kind: "ok" };
  const { hi } = bounds(s);
  if (hi === Infinity) return { kind: "ok" };
  const eta = Date.parse(actual.at);
  if (eta > hi) return { kind: "late", minutes: Math.ceil((eta - hi) / MINUTE) };
  if (s.anchor === "arrive" && hi - eta <= TIGHT_MINUTES * MINUTE) return { kind: "tight", minutes: Math.floor((hi - eta) / MINUTE) };
  return { kind: "ok" };
}

export interface RideTimesInput {
  points: readonly RoutePoint[];
  stretches: RideStretches;
  people: readonly RidePerson[];
  requests: readonly RequestHours[];
  /** The ride's set start (`rides.starts_at`). */
  startsAt: string | null;
}

export function rideTimes({ points, stretches, people, requests, startsAt }: RideTimesInput): RideTimes {
  const legs = LEGS.filter((leg) => stretches?.[leg] && legPoints(points, leg).length >= 2);
  const pointsOf = new Map(legs.map((leg) => [leg, legPoints(points, leg)] as const));
  const actualAt = (leg: RouteLeg, position: number): Actual | null => {
    if (leg === "out" && position === 0 && startsAt) return { at: startsAt, estimate: false };
    const eta = pointsOf.get(leg)?.[position]?.eta;
    return eta ? { at: eta, estimate: true } : null;
  };
  const requestById = new Map(requests.map((request) => [request.id, request] as const));

  // ---- the main people (driver, requesters, "+ נוסעים") and their parts --------------------------------------
  const main = people.filter((person) => !SECONDARY.has(person.source));
  const spansOf = (person: RidePerson): Map<RouteLeg, [number, number]> => {
    const spans = new Map<RouteLeg, [number, number]>();
    for (const leg of legs) {
      let span = personSpan(person, stretches?.[leg]);
      // a volunteer driver (no request of their own) drives the whole of every way
      if (!span && person.source === "driver" && !person.request_id) span = [0, pointsOf.get(leg)!.length - 1];
      if (span) spans.set(leg, span);
    }
    return spans;
  };

  // ---- the stated hours ---------------------------------------------------------------------------------------
  const stated: Stated[] = [];
  const statedOf = new Map<string, Stated[]>();
  const push = (key: string, s: Omit<Stated, "id">) => {
    if (stated.some((x) => x.name === s.name && x.leg === s.leg && x.position === s.position && x.anchor === s.anchor && x.at === s.at)) return;
    const full = { ...s, id: `${key}:${s.leg}:${s.position}:${s.anchor}` };
    stated.push(full);
    statedOf.set(key, [...(statedOf.get(key) ?? []), full]);
  };
  const spans = new Map(main.map((person) => [person.key, spansOf(person)] as const));
  for (const person of main) {
    const request = person.request_id ? requestById.get(person.request_id) : undefined;
    if (!request) continue;
    const name = person.display_name.trim();
    for (const [leg, [board, alight]] of spans.get(person.key) ?? []) {
      const way: RouteLeg = hasReturn(request) ? leg : "out";
      if (way === "out") {
        if (request.depart_anchor !== "arrive" && request.depart_at) {
          push(person.key, { leg, position: board, anchor: "leave", at: request.depart_at, early: minutesOf(request.flex_depart_early), late: minutesOf(request.flex_depart_late), name });
        }
        if (request.arrive_by) push(person.key, { leg, position: alight, anchor: "arrive", at: request.arrive_by, early: 0, late: minutesOf(request.flex_depart_late), name });
      } else {
        if (request.leave_dest_at) {
          push(person.key, { leg, position: board, anchor: "leave", at: request.leave_dest_at, early: minutesOf(request.flex_return_early), late: minutesOf(request.flex_return_late), name });
        }
        if (request.return_anchor === "arrive" && request.return_at) {
          push(person.key, { leg, position: alight, anchor: "arrive", at: request.return_at, early: 0, late: minutesOf(request.flex_return_late), name });
        }
      }
    }
  }
  // the main request's stop hours (LT1 phase 2e: `ride_stretches.fixed`, its destination / way-back hours too)
  const baseId = baseRequestId([...points]);
  const baseOwner = baseId ? main.find((person) => person.request_id === baseId) : undefined;
  if (baseOwner) {
    for (const leg of legs) {
      (stretches?.[leg]?.fixed ?? []).forEach((fixed, position) => {
        if (!fixed) return;
        const flex = fixed.flex ?? 0;
        push(baseOwner.key, { leg, position, anchor: fixed.anchor, at: fixed.at, early: 0, late: flex, name: baseOwner.display_name.trim() });
      });
    }
  }
  const all: Stated[] = startsAt && legs.includes("out")
    ? [...stated, { id: "ride:start", leg: "out", position: 0, anchor: "leave", at: startsAt, early: 0, late: 0, name: "", rideStart: true }]
    : [...stated];
  // the ride's start says nothing new when a person's own hour at that place is the same one (the driver's 09:00)
  const sameHour = (x: Stated, y: Stated) => x.leg === y.leg && x.position === y.position && x.anchor === y.anchor && x.at === y.at;
  const found = definiteConflicts(all);
  const conflicts = found.filter((c) => {
    const [start, other] = c.a.rideStart ? [c.a, c.b] : c.b.rideStart ? [c.b, c.a] : [null, null];
    if (!start || !other) return true;
    return !found.some((d) => d !== c && (d.a === other || d.b === other) && sameHour(d.a === other ? d.b : d.a, start));
  });
  const inConflict = new Set(conflicts.flatMap((c) => [c.a.id, c.b.id]));
  const markOf = (s: Stated): Mark => (inConflict.has(s.id) ? { kind: "conflict" } : estimateMark(s, actualAt(s.leg, s.position)));

  // ---- per person ---------------------------------------------------------------------------------------------
  const perPerson: PersonTimes[] = main.flatMap((person): PersonTimes[] => {
    const own = spans.get(person.key);
    if (!own?.size) return [];
    const mine = statedOf.get(person.key) ?? [];
    const rows: PersonRow[] = [];
    for (const [leg, [board, alight]] of own) {
      const pts = pointsOf.get(leg)!;
      const at = (position: number, anchor: Stated["anchor"]) => mine.find((s) => s.leg === leg && s.position === position && s.anchor === anchor) ?? null;
      const boardStated = at(board, "leave");
      rows.push({ leg, position: board, kind: board === 0 ? "leave" : "board", place: pts[board]?.name ?? "", stated: boardStated,
        actual: actualAt(leg, board), mark: boardStated ? markOf(boardStated) : null });
      const alightStated = at(alight, "arrive");
      const kind: RowKind = alightStated ? "arriveBy" : leg === "return" && alight === pts.length - 1 ? "back" : "alight";
      rows.push({ leg, position: alight, kind, place: pts[alight]?.name ?? "", stated: alightStated,
        actual: actualAt(leg, alight), mark: alightStated ? markOf(alightStated) : null });
    }
    const legsRidden = own.has("out") && own.has("return") ? "both" : own.has("out") ? "out" : "return";
    const withNames = person.request_id
      ? people.filter((other) => other.request_id === person.request_id && SECONDARY.has(other.source)).map((other) => other.display_name.trim()).filter(Boolean)
      : [];
    return [{
      key: person.key,
      name: person.display_name.trim(),
      role: person.source === "driver" ? "driver" : person.source === "added" ? "added" : "rider",
      legs: legsRidden,
      withNames,
      rows,
      conflicts: conflicts.filter((c) => mine.includes(c.a) || mine.includes(c.b)),
    }];
  });

  // ---- per route ----------------------------------------------------------------------------------------------
  const rows = stretches ? stopRows([...points], [...people], stretches) : [];
  const route: PlaceCard[] = rows.filter((row) => legs.includes(row.leg)).map((row) => {
    const here = stated.filter((s) => s.leg === row.leg && s.position === row.point.position);
    return {
      leg: row.leg,
      position: row.point.position,
      first: row.first,
      name: row.point.name,
      isStop: row.point.kind === "stop",
      actual: actualAt(row.leg, row.point.position),
      on: row.on,
      off: row.off,
      free: row.free,
      tags: here.map((s) => ({ stated: s, mark: markOf(s) })),
      conflicts: conflicts.filter((c) => here.includes(c.a) || here.includes(c.b)),
    };
  });

  // ---- header -------------------------------------------------------------------------------------------------
  const spansHeader: LegSpan[] = legs.map((leg) => {
    const last = pointsOf.get(leg)!.length - 1;
    return { leg, from: actualAt(leg, 0), to: actualAt(leg, last) };
  });
  const places: string[] = [];
  for (const leg of legs) for (const point of pointsOf.get(leg)!) if (!places.includes(point.name)) places.push(point.name);

  return { legs: spansHeader, places, people: perPerson, route, conflicts };
}
