// REQ item 246 h (LT1 phase 2b): passengers along the route. Reads `ride_stretches(ride)` (each person's part of
// the route as [board, alight] positions of `v_board_rides.route`, per leg) and builds:
//  * the stops view — at each place who gets off (↓) and on (↑) and the free seats on the next stretch;
//  * the people summary text — nothing for the whole ride, "רק הלוך" / "רק חזור", else only the differences
//    ("↓ עין שמר (08:15) · ↑ עין שמר (16:30)");
//  * the "+ נוסע/ת" / edit dialog's choices (the simplest one that describes how someone rides) and the `parts`
//    payload of `set_ride_person_part` / the places of `add_ride_passengers`.
// Pure: no React, no Supabase, no i18n (the caller passes the words).

import { z } from "zod";

import type { RouteLeg, RoutePoint } from "@/lib/rideRoute";

import type { RidePerson } from "./ridePeople";

const legStretchesSchema = z.object({
  spans: z.record(z.string(), z.tuple([z.number(), z.number()])),
  absent: z.array(z.string()),
  free: z.array(z.number().nullable()),
  /** LT1 phase 2e: per route position, the stated hour of the main request's place (null = worked out). */
  fixed: z.array(z.object({ at: z.string(), anchor: z.enum(["arrive", "leave"]), flex: z.number().nullish() }).nullable()).optional(),
});
export const rideStretchesSchema = z.object({ out: legStretchesSchema.optional(), return: legStretchesSchema.optional() }).nullable();
export type LegStretches = z.infer<typeof legStretchesSchema>;
export type RideStretches = z.infer<typeof rideStretchesSchema>;

export const LEGS: readonly RouteLeg[] = ["out", "return"];

/**
 * LT1 phase 2e (QA run seed 3972): the stated hours beside the ride's own estimates. The estimates stay the shown times
 * (so the places read in order); `kept` = positions whose stated hour the estimate keeps (an arrive-by not later than its
 * flexibility, a leave-at not further either way), `missed` = the others - each with the stated hour.
 */
export function withStatedHours(points: readonly RoutePoint[], stretches: RideStretches | undefined):
  { points: RoutePoint[]; kept: Map<string, string>; missed: Map<string, string> } {
  const kept = new Map<string, string>();
  const missed = new Map<string, string>();
  for (const point of points) {
    const stated = stretches?.[point.leg]?.fixed?.[point.position];
    if (!stated) continue;
    const key = `${point.leg}:${point.position}`;
    const slack = (stated.flex ?? 0) * 60_000;
    const diff = point.eta ? Date.parse(point.eta) - Date.parse(stated.at) : 0;
    const ok = !point.eta || (stated.anchor === "arrive" ? diff <= slack : Math.abs(diff) <= slack);
    (ok ? kept : missed).set(key, stated.at);
  }
  return { points: [...points], kept, missed };
}

/** Route points of one leg, in order (positions of `v_board_rides.route`). */
export function legPoints(points: readonly RoutePoint[], leg: RouteLeg): RoutePoint[] {
  return points.filter((p) => p.leg === leg).sort((a, b) => a.position - b.position);
}

/** [board, alight] of one person on one leg, or null when they do not ride it. */
export function personSpan(person: Pick<RidePerson, "key" | "request_id" | "source">, leg: LegStretches | undefined): [number, number] | null {
  if (!leg) return null;
  const own = leg.spans[person.key];
  if (own) return own;
  if (leg.absent.includes(person.key)) return null;
  // a request's people without a row of their own ride the request's part
  if (person.request_id && person.source !== "added" && person.source !== "driver") return leg.spans[`req:${person.request_id}`] ?? null;
  return null;
}

export interface StopRow {
  leg: RouteLeg;
  /** First place of the leg (the header goes above it). */
  first: boolean;
  point: RoutePoint;
  /** Names getting off here (at the leg's last place: everyone still on - owner 2026-11-16, easy to follow). */
  off: string[];
  /** Names getting on here (at the leg's first place: everyone starting there). */
  on: string[];
  /** Free adult seats on the stretch after this place; null at the last place or when unknown. */
  free: number | null;
}

/** The stops view: one row per place of each leg the ride carries. */
export function stopRows(points: readonly RoutePoint[], people: readonly RidePerson[], stretches: RideStretches): StopRow[] {
  const rows: StopRow[] = [];
  for (const leg of LEGS) {
    const data = stretches?.[leg];
    const pts = legPoints(points, leg);
    if (!data || pts.length < 2) continue;
    const last = pts.length - 1;
    pts.forEach((point, i) => {
      const off: string[] = [];
      const on: string[] = [];
      for (const person of people) {
        const span = personSpan(person, data);
        if (!span) continue;
        if (span[0] === i) on.push(person.display_name.trim());
        if (span[1] === i) off.push(person.display_name.trim());
      }
      rows.push({ leg, first: i === 0, point, off, on, free: i < last ? (data.free[i] ?? null) : null });
    });
  }
  return rows;
}

export interface SummaryWords {
  outOnly: string;
  returnOnly: string;
  /** e.g. (name, time) => `↑ ${name} (${time})` */
  on: (name: string, time: string | null) => string;
  off: (name: string, time: string | null) => string;
}

/** The people summary's text for one person: "" for the whole ride, "רק הלוך" / "רק חזור", else the differences. */
export function personWhere(person: RidePerson, points: readonly RoutePoint[], stretches: RideStretches, words: SummaryWords, time: (iso: string) => string): string {
  const legs = LEGS.filter((leg) => stretches?.[leg] && legPoints(points, leg).length >= 2);
  if (!legs.length) return "";
  const spans = Object.fromEntries(legs.map((leg) => [leg, personSpan(person, stretches?.[leg])])) as Record<RouteLeg, [number, number] | null>;
  const whole = (leg: RouteLeg) => {
    const span = spans[leg];
    return !!span && span[0] === 0 && span[1] === legPoints(points, leg).length - 1;
  };
  if (legs.every(whole)) return "";
  const parts: string[] = [];
  if (legs.length === 2) {
    if (whole("out") && !spans.return) return words.outOnly;
    if (whole("return") && !spans.out) return words.returnOnly;
    if (!spans.out) parts.push(words.returnOnly);
    if (!spans.return) parts.push(words.outOnly);
  }
  for (const leg of legs) {
    const span = spans[leg];
    if (!span) continue;
    const pts = legPoints(points, leg);
    const board = pts[span[0]];
    const alight = pts[span[1]];
    if (span[0] !== 0 && board) parts.push(words.on(board.name, board.eta ? time(board.eta) : null));
    if (span[1] !== pts.length - 1 && alight) parts.push(words.off(alight.name, alight.eta ? time(alight.eta) : null));
  }
  return parts.join(" · ");
}

/** How someone rides, as the dialog edits it: per leg null (not riding) or [board, alight] positions. */
export type PartChoice = "whole" | "out" | "return" | "middle";
export interface PersonParts {
  choice: PartChoice;
  out: [number, number] | null;
  return: [number, number] | null;
}

/** The legs the ride carries (with at least two places). */
export function rideLegs(points: readonly RoutePoint[]): RouteLeg[] {
  return LEGS.filter((leg) => legPoints(points, leg).length >= 2);
}

function fullSpan(points: readonly RoutePoint[], leg: RouteLeg): [number, number] {
  return [0, legPoints(points, leg).length - 1];
}

/** The parts for a choice of the simple chips (whole / out only / return only). */
export function partsFor(choice: Exclude<PartChoice, "middle">, points: readonly RoutePoint[], legs: readonly RouteLeg[] = rideLegs(points)): PersonParts {
  const on = (leg: RouteLeg) => (legs.includes(leg) && (choice === "whole" || choice === leg) ? fullSpan(points, leg) : null);
  return { choice, out: on("out"), return: on("return") };
}

/** The dialog opened on someone: the simplest choice that describes how they ride now. */
export function currentParts(person: RidePerson, points: readonly RoutePoint[], stretches: RideStretches, legs: readonly RouteLeg[] = rideLegs(points)): PersonParts {
  const span = (leg: RouteLeg) => (legs.includes(leg) ? personSpan(person, stretches?.[leg]) : null);
  const out = span("out");
  const ret = span("return");
  const isFull = (leg: RouteLeg, s: [number, number] | null) => !!s && s[0] === 0 && s[1] === legPoints(points, leg).length - 1;
  const outFull = !legs.includes("out") || isFull("out", out);
  const retFull = !legs.includes("return") || isFull("return", ret);
  if (outFull && retFull && (out || ret)) return { choice: "whole", out, return: ret };
  if (legs.length === 2 && isFull("out", out) && !ret) return { choice: "out", out, return: null };
  if (legs.length === 2 && isFull("return", ret) && !out) return { choice: "return", out: null, return: ret };
  return { choice: "middle", out, return: ret };
}

/** A place on the route as the RPCs take it (null = the leg's start / end). */
export interface PlaceRef {
  place_id?: string;
  place_text?: string;
}

function placeOf(point: RoutePoint | undefined): PlaceRef | null {
  if (!point) return null;
  if (point.placeId) return { place_id: point.placeId };
  if (point.placeText) return { place_text: point.placeText };
  return null;
}

/** One leg's places for the RPCs: board / alight, null when it is the leg's start / end. */
export function legPlaces(points: readonly RoutePoint[], leg: RouteLeg, span: [number, number]) {
  const pts = legPoints(points, leg);
  const board = span[0] > 0 ? placeOf(pts[span[0]]) : null;
  const alight = span[1] < pts.length - 1 ? placeOf(pts[span[1]]) : null;
  return {
    ...(board?.place_id ? { board_place_id: board.place_id } : board?.place_text ? { board_place_text: board.place_text } : {}),
    ...(alight?.place_id ? { alight_place_id: alight.place_id } : alight?.place_text ? { alight_place_text: alight.place_text } : {}),
  };
}

/** `set_ride_person_part`'s parts: each leg the ride carries, null = not riding it. */
export function partsPayload(parts: PersonParts, points: readonly RoutePoint[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const leg of rideLegs(points)) {
    const span = parts[leg];
    out[leg] = span ? legPlaces(points, leg, span) : null;
  }
  return out;
}

/** `add_ride_passengers`' leg and places for one passenger (the way back's places on a row riding both ways). */
export function addPayload(parts: PersonParts, points: readonly RoutePoint[]): Record<string, unknown> {
  const legs = rideLegs(points);
  const both = !!parts.out && !!parts.return && legs.length === 2;
  if (both) {
    const back = legPlaces(points, "return", parts.return as [number, number]);
    return {
      leg: "both",
      ...legPlaces(points, "out", parts.out as [number, number]),
      ...Object.fromEntries(Object.entries(back).map(([k, v]) => [`return_${k}`, v])),
    };
  }
  const leg: RouteLeg = parts.out ? "out" : "return";
  const span = parts[leg];
  // a ride carrying one direction: the row's leg is "both" (the whole ride), its places that direction's
  return { leg: legs.length === 2 ? leg : "both", ...(span ? legPlaces(points, leg, span) : {}) };
}

/**
 * Is there room for `adults` more people on every stretch they ride? From the stops view's free seats; when editing,
 * `minus` is the edited person's own current part (their seat is free for them). Unknown (no seat data) = room.
 */
export function roomFor(parts: PersonParts, stretches: RideStretches, adults: number, minus?: PersonParts | null): boolean {
  if (adults <= 0) return true;
  for (const leg of LEGS) {
    const span = parts[leg];
    const free = stretches?.[leg]?.free;
    if (!span || !free) continue;
    const own = minus?.[leg];
    for (let k = span[0]; k < span[1]; k++) {
      const f = free[k];
      if (f == null) continue;
      const back = own && own[0] <= k && k < own[1] ? 1 : 0;
      if (f + back < adults) return false;
    }
  }
  return true;
}

/** The base request of the ride (whose route the ride follows): the request of the way there's origin. */
export function baseRequestId(points: readonly RoutePoint[]): string | null {
  return legPoints(points, "out")[0]?.requestId ?? legPoints(points, "return")[0]?.requestId ?? null;
}

export interface PersonDialogSetup {
  legs: RouteLeg[];
  initial: PersonParts;
  /** "עולה או יורד/ת באמצע…" offered. */
  middle: boolean;
  /** The places they may get on / off at (the base request's own places for its people). */
  allowedPositions?: Partial<Record<RouteLeg, number[]>>;
  /** Riding a way = all of it (a merged guest request's people: their request decides the places). */
  wholeLegsOnly: boolean;
}

/** What the edit dialog offers one person on the ride, and how it opens. */
export function personDialogSetup(person: RidePerson, points: readonly RoutePoint[], stretches: RideStretches | undefined): PersonDialogSetup {
  const all = rideLegs(points);
  const legs = person.source === "added" || !person.leg || person.leg === "both" ? all : all.filter((leg) => leg === person.leg);
  const base = baseRequestId(points);
  const isBase = !!person.request_id && person.request_id === base;
  const wholeLegsOnly = person.source !== "added" && !isBase;
  const hasMiddle = LEGS.some((leg) => legPoints(points, leg).length > 2);
  let initial: PersonParts;
  if (stretches) {
    initial = currentParts(person, points, stretches, legs);
    if (wholeLegsOnly) {
      // their part of a way is their request's: riding it = all of it here
      const on = (leg: RouteLeg) => (legs.includes(leg) && personSpan(person, stretches[leg]) ? fullSpan(points, leg) : null);
      const out = on("out");
      const ret = on("return");
      const choice: PartChoice = legs.length === 2 && out && !ret ? "out" : legs.length === 2 && ret && !out ? "return" : "whole";
      initial = { choice, out, return: ret };
    }
  } else {
    // a plain ride (no stops view): the person's direction
    initial = partsFor(person.leg === "out" || person.leg === "return" ? (legs.length === 2 ? person.leg : "whole") : "whole", points, legs);
  }
  const allowedPositions = isBase && person.source !== "added"
    ? Object.fromEntries(legs.map((leg) => [leg, legPoints(points, leg).flatMap((p, i) =>
        p.requestId === base && (p.kind === "origin" || p.kind === "stop" || p.kind === "destination") ? [i] : [])]))
    : undefined;
  return { legs, initial, middle: hasMiddle && !wholeLegsOnly, allowedPositions, wholeLegsOnly };
}
