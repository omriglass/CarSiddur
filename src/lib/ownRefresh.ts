/**
 * O28-8 (board speed): which department-weeks this tab has just refreshed after its own change
 * (`invalidateWeekData`). The live-sync broadcast of that same change (it carries this tab's id, `tabId.ts`)
 * then skips its second reload. Only a recent refresh counts, so a broadcast of a change the tab made without
 * refreshing still reloads; another tab's or person's broadcast always does.
 */
export const OWN_REFRESH_WINDOW_MS = 5_000;

const refreshedAt = new Map<string, number>();

function key(departmentId: string, weekStart: string): string {
  return `${departmentId}|${weekStart}`;
}

export function noteOwnRefresh(departmentId: string, weekStart: string, now: number = Date.now()): void {
  refreshedAt.set(key(departmentId, weekStart), now);
}

export function refreshedRecently(departmentId: string, weekStart: string, now: number = Date.now()): boolean {
  const at = refreshedAt.get(key(departmentId, weekStart));
  return at !== undefined && now - at <= OWN_REFRESH_WINDOW_MS;
}

/** Tests only. */
export function resetOwnRefresh(): void {
  refreshedAt.clear();
}
