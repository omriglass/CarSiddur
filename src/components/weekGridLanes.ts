/**
 * Interval partitioning for a `WeekGrid`'s "missing car" columns: one lane per simultaneous item,
 * reused after each item ends. The board packs unmet requests with it, the member siddur its
 * waiting-list columns (REQ §13.182). Ties break by id, so the layout is stable.
 */
export function packPhantomLanes<T extends { id: string; startMinutes: number; endMinutes: number }>(items: readonly T[]): (T & { lane: number })[] {
  const ends: number[] = [];
  return [...items].sort((a, b) => a.startMinutes - b.startMinutes || a.id.localeCompare(b.id)).map((item) => {
    let lane = ends.findIndex((end) => end <= item.startMinutes);
    if (lane < 0) lane = ends.length;
    ends[lane] = item.endMinutes;
    return { ...item, lane };
  });
}

