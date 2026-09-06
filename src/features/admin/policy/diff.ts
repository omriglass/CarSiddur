// Pure ranking-delta / "would flip" helpers for the policy editor's "test on
// last week" preview (docs/UX_FLOWS.md §5.8). Takes plain score maps / served
// sets so it is trivially unit-testable without a real `solve()` run; the
// screen wires it to `@/solver` (`normalize`, `scoreRequests`, `solve`).

export interface RankingRow {
  requestId: string;
  currentScore: number | null;
  currentRank: number | null;
  newScore: number | null;
  newRank: number | null;
  /** currentRank - newRank; positive = moved up, negative = moved down, null if absent from one side. */
  rankDelta: number | null;
}

/** Ranks a score map descending, ties broken by `requestId` (ascending) — the solver's own tie-break rule. */
function rank(scores: Map<string, number>): Map<string, number> {
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const ranks = new Map<string, number>();
  ranked.forEach(([id], i) => ranks.set(id, i + 1));
  return ranks;
}

/**
 * Builds one row per request id appearing in either score map, sorted by the
 * *new* ranking. A request missing from one side (e.g. it didn't exist in
 * last week's batch under some hypothetical filter) gets `null` for that
 * side rather than being dropped.
 */
export function computeRankingDelta(
  currentScores: Map<string, number>,
  newScores: Map<string, number>,
): RankingRow[] {
  const currentRanks = rank(currentScores);
  const newRanks = rank(newScores);
  const ids = new Set([...currentScores.keys(), ...newScores.keys()]);

  const rows: RankingRow[] = [...ids].map((requestId) => {
    const currentRank = currentRanks.get(requestId) ?? null;
    const newRank = newRanks.get(requestId) ?? null;
    return {
      requestId,
      currentScore: currentScores.get(requestId) ?? null,
      currentRank,
      newScore: newScores.get(requestId) ?? null,
      newRank,
      rankDelta: currentRank !== null && newRank !== null ? currentRank - newRank : null,
    };
  });

  return rows.sort((a, b) => {
    if (a.newRank === null) return 1;
    if (b.newRank === null) return -1;
    return a.newRank - b.newRank;
  });
}

export interface FlipRow {
  requestId: string;
  direction: "servedToUnmet" | "unmetToServed";
}

/** Requests whose served/unmet outcome differs between the two solver runs. */
export function computeFlips(currentServedIds: ReadonlySet<string>, newServedIds: ReadonlySet<string>): FlipRow[] {
  const flips: FlipRow[] = [];
  const allIds = new Set([...currentServedIds, ...newServedIds]);
  for (const id of [...allIds].sort()) {
    const wasServed = currentServedIds.has(id);
    const isServed = newServedIds.has(id);
    if (wasServed && !isServed) flips.push({ requestId: id, direction: "servedToUnmet" });
    else if (!wasServed && isServed) flips.push({ requestId: id, direction: "unmetToServed" });
  }
  return flips;
}
