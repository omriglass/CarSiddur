// REQ §13.101 (d, QM3): the same named child on two overlapping requests of different parents
// (two parents filing the same run). A warning for the Sadran only - nothing is blocked.
import { requestStart, requestWindow } from "./phantomLanes";

import type { WeekRequestRow } from "../api";

const INACTIVE = new Set<string>(["draft", "withdrawn", "cancelled", "denied"]);

export interface DuplicateChildRun {
  childName: string;
  requests: WeekRequestRow[];
  /** Local day key of the earlier request's start (for the "selected day" filter). */
  startsAt: string;
}


function overlaps(a: WeekRequestRow, b: WeekRequestRow): boolean {
  const wa = requestWindow(a);
  const wb = requestWindow(b);
  if (!wa || !wb) return false;
  return Date.parse(wa.startsAt) < Date.parse(wb.endsAt) && Date.parse(wb.startsAt) < Date.parse(wa.endsAt);
}

function key(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * One entry per (child, pair of overlapping requests from different requesters). Sorted by start
 * time then request ids so the order is stable.
 */
export function duplicateChildRuns(requests: readonly WeekRequestRow[]): DuplicateChildRun[] {
  const active = requests.filter((request) => !INACTIVE.has(request.status) && (request.childNames?.length ?? 0) > 0 && !!requestStart(request));
  const result: DuplicateChildRun[] = [];
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i]!;
      const b = active[j]!;
      if (a.requester_id === b.requester_id || !overlaps(a, b)) continue;
      const namesB = new Set((b.childNames ?? []).map(key));
      const shared = (a.childNames ?? []).filter((name) => namesB.has(key(name)));
      for (const childName of new Set(shared)) {
        const pair = [a, b].sort((x, y) => Date.parse(requestStart(x)!) - Date.parse(requestStart(y)!) || x.id.localeCompare(y.id));
        result.push({ childName, requests: pair, startsAt: requestStart(pair[0]!)! });
      }
    }
  }
  return result.sort((x, y) => Date.parse(x.startsAt) - Date.parse(y.startsAt) || x.requests[0]!.id.localeCompare(y.requests[0]!.id) || x.childName.localeCompare(y.childName));
}

