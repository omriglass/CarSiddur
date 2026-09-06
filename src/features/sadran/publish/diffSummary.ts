// src/features/sadran/publish/diffSummary.ts
//
// Publish confirmation's `DiffSummary` (UX_FLOWS.md §4.5): compares the
// current draft (about to be published) against the last published
// `siddur_versions.snapshot` (DATA_MODEL.md §3.9, `publish_siddur` RPC). The
// snapshot stores full `rides` rows and a reduced `requests` projection
// (`{id, requester_id, status, status_reason}`) but no `ride_requests` join,
// so a per-ride "who's now merged with whom" diff isn't derivable from it —
// only ride-level (new/changed-time/cancelled) and request-level
// (status changed -> notified) diffs are, which is exactly what
// `publish_siddur` itself uses to decide who gets a push. Pure data, no
// Supabase/React/Hebrew.

export interface DiffRideRow {
  id: string;
  starts_at: string;
  ends_at: string;
  car_id: string;
  status: string;
}

export interface DiffRequestRow {
  id: string;
  status: string;
  status_reason: string | null;
}

export interface DiffSummaryResult {
  newRides: number;
  changedTimeRides: number;
  cancelledRides: number;
  /** Requests whose `status` differs from the last published version (or every request, on a first publish). */
  notifiedCount: number;
  /** Requests unchanged since the last publish — get no notification. */
  unnotifiedCount: number;
  /** `true` when there is no previous version (first publish of this week). */
  isFirstPublish: boolean;
}

export function computeDiffSummary(params: {
  previousRides: readonly DiffRideRow[] | null;
  currentRides: readonly DiffRideRow[];
  previousRequests: readonly DiffRequestRow[] | null;
  currentRequests: readonly DiffRequestRow[];
}): DiffSummaryResult {
  const { previousRides, currentRides, previousRequests, currentRequests } = params;

  if (previousRides === null || previousRequests === null) {
    return {
      newRides: currentRides.filter((r) => r.status !== "cancelled").length,
      changedTimeRides: 0,
      cancelledRides: 0,
      notifiedCount: currentRequests.length,
      unnotifiedCount: 0,
      isFirstPublish: true,
    };
  }

  const prevRideById = new Map(previousRides.map((r) => [r.id, r]));
  const currRideById = new Map(currentRides.map((r) => [r.id, r]));

  let newRides = 0;
  let changedTimeRides = 0;
  let cancelledRides = 0;

  for (const [id, cur] of currRideById) {
    const prev = prevRideById.get(id);
    if (!prev) {
      if (cur.status !== "cancelled") newRides += 1;
      continue;
    }
    if (cur.status === "cancelled" && prev.status !== "cancelled") {
      cancelledRides += 1;
      continue;
    }
    if (prev.starts_at !== cur.starts_at || prev.ends_at !== cur.ends_at || prev.car_id !== cur.car_id) {
      changedTimeRides += 1;
    }
  }
  for (const [id, prev] of prevRideById) {
    if (!currRideById.has(id) && prev.status !== "cancelled") cancelledRides += 1;
  }

  const prevRequestById = new Map(previousRequests.map((r) => [r.id, r]));
  let notifiedCount = 0;
  let unnotifiedCount = 0;
  for (const cur of currentRequests) {
    const prev = prevRequestById.get(cur.id);
    if (!prev || prev.status !== cur.status) notifiedCount += 1;
    else unnotifiedCount += 1;
  }

  return { newRides, changedTimeRides, cancelledRides, notifiedCount, unnotifiedCount, isFirstPublish: false };
}
