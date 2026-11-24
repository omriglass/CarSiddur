// Silent drops item 3 (owner 2026-11-24): which route points a change takes out, so the person making it is asked
// first when a rider gets on / off there (`riders_losing_places`). Pure.
import type { RoutePoint } from "@/lib/rideRoute";

import type { RemovedRoutePoint } from "./api";

interface PlaceRef { leg: "out" | "return"; placeId?: string | null; placeText?: string | null }

function toRemoved(point: PlaceRef): RemovedRoutePoint | null {
  if (point.placeId) return { leg: point.leg, place_id: point.placeId };
  if (point.placeText?.trim()) return { leg: point.leg, place_text: point.placeText.trim() };
  return null;
}

/** The places a guest put on the route (where they board and get off) - what leaves it when the guest leaves. */
export function guestRoutePoints(points: readonly RoutePoint[], requestId: string): RemovedRoutePoint[] {
  return points.flatMap((point) => (point.requestId === requestId && (point.kind === "board" || point.kind === "alight")
    ? [toRemoved(point)].filter((p): p is RemovedRoutePoint => !!p) : []));
}

const keyOf = (point: PlaceRef) => `${point.leg}|${point.placeId ?? `t:${(point.placeText ?? "").trim().toLowerCase()}`}`;

/** The places in `before` that `after` no longer has (as many times as they were dropped), per leg. */
export function removedPlaces(before: readonly PlaceRef[], after: readonly PlaceRef[]): RemovedRoutePoint[] {
  const left = new Map<string, number>();
  for (const point of after) left.set(keyOf(point), (left.get(keyOf(point)) ?? 0) + 1);
  const out: RemovedRoutePoint[] = [];
  for (const point of before) {
    const key = keyOf(point);
    const n = left.get(key) ?? 0;
    if (n > 0) { left.set(key, n - 1); continue; }
    const removed = toRemoved(point);
    if (removed) out.push(removed);
  }
  return out;
}

/** "נועה, דן" at "זכרון יעקב, מצר" - the names and places for the question, each once, in order. */
export function losingPlacesText(rows: readonly { name: string; place: string }[]): { names: string; places: string } {
  const unique = (values: string[]) => [...new Set(values.filter(Boolean))].join(", ");
  return { names: unique(rows.map((row) => row.name)), places: unique(rows.map((row) => row.place)) };
}

