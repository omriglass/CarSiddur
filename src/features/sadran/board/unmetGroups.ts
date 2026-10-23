// R14M3: two unmet one-way legs of one member that are each other's mirror (X→Y then Y→X, same day) are the
// out + return of one errand: the board lists them as one group under the member's name, each leg still its own
// card (placeable/draggable on its own). Pure: no React, no Supabase.
import { requestStart, tripTypeOf } from "./phantomLanes";

import type { WeekRequestRow } from "../api";

interface GroupableItem {
  request: WeekRequestRow;
  leg?: "out" | "return";
}

export interface UnmetGroup<T extends GroupableItem> {
  key: string;
  /** One item, or the two mirrored legs in departure order. */
  items: T[];
}

function legEnds(request: WeekRequestRow, homeId?: string | null): { from: string; to: string } | null {
  const from = request.origin_id ?? homeId ?? null;
  const to = request.destination_id ?? null;
  return from && to && from !== to ? { from, to } : null;
}

function sameDay(a: string, b: string): boolean {
  return a.slice(0, 10) === b.slice(0, 10) || Math.abs(Date.parse(a) - Date.parse(b)) < 12 * 3_600_000;
}

/** True when `b` is the way back of `a`: same member, one-way each, mirrored places, `b` leaves after `a`. */
export function areComplementaryLegs(a: WeekRequestRow, b: WeekRequestRow, homeId?: string | null): boolean {
  if (a.id === b.id || a.requester_id !== b.requester_id) return false;
  if (tripTypeOf(a) !== "one_way" || tripTypeOf(b) !== "one_way") return false;
  const ea = legEnds(a, homeId);
  const eb = legEnds(b, homeId);
  const sa = requestStart(a);
  const sb = requestStart(b);
  if (!ea || !eb || !sa || !sb) return false;
  return ea.from === eb.to && ea.to === eb.from && Date.parse(sb) >= Date.parse(sa) && sameDay(sa, sb);
}

/** Keeps the given order; a mirrored mate joins the group of the first leg it answers. */
export function groupComplementaryLegs<T extends GroupableItem>(items: readonly T[], homeId?: string | null): UnmetGroup<T>[] {
  const used = new Set<number>();
  const groups: UnmetGroup<T>[] = [];
  items.forEach((item, index) => {
    if (used.has(index)) return;
    used.add(index);
    const found = item.leg ? -1 : items.findIndex((other, j) => j !== index && !used.has(j) && !other.leg
      && (areComplementaryLegs(item.request, other.request, homeId) || areComplementaryLegs(other.request, item.request, homeId)));
    if (found < 0) { groups.push({ key: item.request.id + (item.leg === "return" ? ":return" : ""), items: [item] }); return; }
    used.add(found);
    const pair = [item, items[found] as T].sort((x, y) => (requestStart(x.request) ?? "").localeCompare(requestStart(y.request) ?? "") || x.request.id.localeCompare(y.request.id));
    groups.push({ key: pair.map((p) => p.request.id).join("+"), items: pair });
  });
  return groups;
}
