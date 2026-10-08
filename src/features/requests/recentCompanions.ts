// UX_FLOWS §3.4a "who sheet": the people who travelled with the member on their own recent
// requests (`request_companions` of requests they filed), most recently used first.
export interface RecentCompanionRow {
  profileId: string;
  /** The request's own time — newer first; rows without any time sort last. */
  at: string | null;
}

export const RECENT_COMPANION_COUNT = 4;

export function recentCompanionIds(rows: readonly RecentCompanionRow[], selfId: string | undefined, limit = RECENT_COMPANION_COUNT): string[] {
  const stamp = (row: RecentCompanionRow) => Date.parse(row.at ?? "") || 0;
  const seen = new Set<string>();
  for (const row of [...rows].sort((a, b) => stamp(b) - stamp(a))) {
    if (row.profileId === selfId) continue;
    seen.add(row.profileId);
    if (seen.size >= limit) break;
  }
  return [...seen];
}
