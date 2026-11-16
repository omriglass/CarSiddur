// REQ item 246 h (LT1 phase 2b): who of a request rides which part of its route - `request_rider_stops` rows
// (`submit_request` `riders`; no row = the whole ride). The form edits them per person with the ride sheet's picker
// (`features/rides/components/RidePartsPicker`) on the request's own route: the way there origin -> its stops ->
// destination, the way back destination -> its stops -> origin. Places, not positions, are stored, so editing the
// stops never points at the wrong place (a place no longer on the route = the whole leg).
import { z } from "zod";

import type { DestinationValue } from "@/components/DestinationCombobox";
import type { RoutePoint } from "@/lib/rideRoute";
import { legPlaces, legPoints, type PersonParts } from "@/features/rides/rideStretches";

export const riderRowSchema = z.object({
  rider_key: z.string(),
  leg: z.enum(["out", "return"]),
  rides: z.boolean(),
  seat_kind: z.enum(["adult", "child_seat", "booster"]).optional(),
  board_place_id: z.string().nullish(),
  board_place_text: z.string().nullish(),
  alight_place_id: z.string().nullish(),
  alight_place_text: z.string().nullish(),
});
export type RiderRow = z.infer<typeof riderRowSchema>;

export interface RouteValues {
  origin: DestinationValue | null | undefined;
  destination: DestinationValue | null | undefined;
  outStops: readonly DestinationValue[];
  returnStops: readonly DestinationValue[];
  hasReturn: boolean;
}

function point(leg: "out" | "return", position: number, value: DestinationValue | null | undefined, name: string): RoutePoint {
  const placeId = value && "presetId" in value ? value.presetId : null;
  const placeText = value && "freeText" in value ? value.freeText.trim() || null : null;
  return { leg, position, placeId, placeText, name, requestId: null, kind: "stop", eta: null };
}

/** The request's own route as route points (names by `nameOf`). */
export function requestRoutePoints(values: RouteValues, nameOf: (value: DestinationValue | null | undefined) => string): RoutePoint[] {
  const out = [values.origin, ...values.outStops, values.destination];
  const back = values.hasReturn ? [values.destination, ...values.returnStops, values.origin] : [];
  return [
    ...out.map((v, i) => point("out", i, v, nameOf(v))),
    ...back.map((v, i) => point("return", i, v, nameOf(v))),
  ];
}

function samePlace(p: RoutePoint, id: string | null | undefined, text: string | null | undefined): boolean {
  if (id) return p.placeId === id;
  if (text) return !!p.placeText && p.placeText.toLowerCase() === text.trim().toLowerCase();
  return false;
}

/** A rider's part of one leg from their row (null = not riding it); no row = all of it. */
export function rowSpan(row: RiderRow | undefined, pts: readonly RoutePoint[]): [number, number] | null {
  const last = pts.length - 1;
  if (!row) return [0, last];
  if (!row.rides) return null;
  let board = 0;
  if (row.board_place_id || row.board_place_text) {
    const i = pts.findIndex((p, k) => k < last && samePlace(p, row.board_place_id, row.board_place_text));
    if (i < 0) return [0, last];
    board = i;
  }
  let alight = last;
  if (row.alight_place_id || row.alight_place_text) {
    const i = pts.findIndex((p, k) => k > board && samePlace(p, row.alight_place_id, row.alight_place_text));
    if (i < 0) return [0, last];
    alight = i;
  }
  return board < alight ? [board, alight] : [0, last];
}

/** One person's parts from their rows (the dialog opens on the simplest choice). */
export function riderParts(key: string, riders: readonly RiderRow[], points: readonly RoutePoint[]): PersonParts {
  const legs = (["out", "return"] as const).filter((leg) => legPoints(points, leg).length >= 2);
  const spans = Object.fromEntries(legs.map((leg) => [leg, rowSpan(riders.find((r) => r.rider_key === key && r.leg === leg), legPoints(points, leg))]));
  const out: [number, number] | null = spans.out ?? null;
  const ret: [number, number] | null = spans.return ?? null;
  const full = (leg: "out" | "return", s: [number, number] | null) => !!s && s[0] === 0 && s[1] === legPoints(points, leg).length - 1;
  const outFull = !legs.includes("out") || full("out", out);
  const retFull = !legs.includes("return") || full("return", ret);
  if (outFull && retFull && (out || ret)) return { choice: "whole", out, return: ret };
  if (legs.length === 2 && full("out", out) && !ret) return { choice: "out", out, return: null };
  if (legs.length === 2 && full("return", ret) && !out) return { choice: "return", out: null, return: ret };
  return { choice: "middle", out, return: ret };
}

/** The rows for one person's parts (the whole of a leg = no row), replacing their old ones. */
export function withRiderParts(riders: readonly RiderRow[], key: string, seatKind: RiderRow["seat_kind"], parts: PersonParts, points: readonly RoutePoint[]): RiderRow[] {
  const rows: RiderRow[] = riders.filter((r) => r.rider_key !== key);
  for (const leg of ["out", "return"] as const) {
    const pts = legPoints(points, leg);
    if (pts.length < 2) {
      // a leg the request does not have now (one way): keep its row as it was
      rows.push(...riders.filter((r) => r.rider_key === key && r.leg === leg));
      continue;
    }
    const span = parts[leg];
    if (!span) { rows.push({ rider_key: key, leg, rides: false, ...(seatKind ? { seat_kind: seatKind } : {}) }); continue; }
    const places = legPlaces(points, leg, span);
    if (Object.keys(places).length) rows.push({ rider_key: key, leg, rides: true, ...(seatKind ? { seat_kind: seatKind } : {}), ...places });
  }
  return rows;
}

/** The rows of people still on the request (a removed companion / child / guest takes their rows along). */
export function ridersOfPeople(riders: readonly RiderRow[], people: { companions: readonly string[]; children: readonly string[]; guests: number }): RiderRow[] {
  return riders.filter((r) => {
    const [kind, id] = [r.rider_key.slice(0, r.rider_key.indexOf(":")), r.rider_key.slice(r.rider_key.indexOf(":") + 1)];
    if (kind === "companion") return people.companions.includes(id);
    if (kind === "child") return people.children.includes(id);
    if (kind === "guest") return Number(id) >= 1 && Number(id) <= people.guests;
    return false;
  });
}

