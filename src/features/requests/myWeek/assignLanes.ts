// Owner 2026-10-11, "my rides" week view: several of a member's items can share a day (a ride, a request, a
// suggestion...), unlike a car column which never holds two rides at once. Overlapping items sit side by side:
// interval-graph clustering (a cluster = items connected by overlaps), first-fit lanes inside each cluster, and every
// item of a cluster gets that cluster's lane count so the cluster fills the column evenly. Pure and deterministic:
// every sort ends in the id.

export interface LaneInput {
  id: string;
  /** The column (day) the item is drawn in; items in different columns never share a lane. */
  carId: string;
  startMinutes: number;
  endMinutes: number;
}

export interface LaneAssignment {
  lane: number;
  laneCount: number;
}

/** `WeekGrid` draws every block at least ~30 minutes tall (`RIDE_MIN_HEIGHT_PX`), so a shorter item still occupies that much. */
export const MIN_LANE_MINUTES = 30;

function effectiveEnd(item: LaneInput, minMinutes: number): number {
  return Math.max(item.endMinutes, item.startMinutes + minMinutes);
}

export function assignLanes(items: readonly LaneInput[], minMinutes: number = MIN_LANE_MINUTES): Map<string, LaneAssignment> {
  const result = new Map<string, LaneAssignment>();
  const byColumn = new Map<string, LaneInput[]>();
  for (const item of items) {
    const list = byColumn.get(item.carId) ?? [];
    list.push(item);
    byColumn.set(item.carId, list);
  }
  for (const column of byColumn.values()) {
    // Earlier first, the longer of two equal starts first, then id.
    const sorted = [...column].sort((a, b) =>
      a.startMinutes - b.startMinutes
      || effectiveEnd(b, minMinutes) - effectiveEnd(a, minMinutes)
      || a.id.localeCompare(b.id));
    let cluster: { item: LaneInput; lane: number }[] = [];
    let laneEnds: number[] = [];
    let clusterEnd = Number.NEGATIVE_INFINITY;
    const flush = () => {
      for (const entry of cluster) result.set(entry.item.id, { lane: entry.lane, laneCount: laneEnds.length });
      cluster = [];
      laneEnds = [];
      clusterEnd = Number.NEGATIVE_INFINITY;
    };
    for (const item of sorted) {
      // A start at or after the cluster's furthest end opens a new cluster (touching items do not overlap).
      if (cluster.length > 0 && item.startMinutes >= clusterEnd) flush();
      let lane = laneEnds.findIndex((end) => end <= item.startMinutes);
      const end = effectiveEnd(item, minMinutes);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(end);
      } else {
        laneEnds[lane] = end;
      }
      cluster.push({ item, lane });
      clusterEnd = Math.max(clusterEnd, end);
    }
    flush();
  }
  return result;
}
