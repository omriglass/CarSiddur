import type { Query, QueryKey } from "@tanstack/react-query";

/**
 * Return-to-tab gating (REQ item 149, ARCHITECTURE.md §12.1): a week's ride/board queries are covered
 * by that week's change counter, which `useWeekChangeWatch` checks on every return to the tab and which
 * invalidates exactly what moved. For those queries a plain "older than 30 s" focus refetch is
 * redundant, so while a watcher covers the week they skip it — unless they are older than
 * `GATE_MAX_AGE_MS` (safety cap: a missed counter heals within five minutes of a return).
 *
 * Deliberately NOT gated (they keep today's focus refetch): everything outside the list below —
 * inbox, cross-week request lists, my upcoming rides (server filters `ends_at > now` with the
 * client's clock, so ended rides leave only on a refetch; may also hold manager-only draft rides),
 * catalogs, solver figures (`fairnessStats`, `mileageTotals`, `carStartLocations`, `placeTravel`),
 * car locations, other departments' siddur (no watcher) and permissions.
 *
 * This module holds no React and no Supabase: `registerWatch` is called by the hook, `gatesFocusRefetch`
 * by the QueryClient's `refetchOnWindowFocus`.
 */
export const GATE_MAX_AGE_MS = 5 * 60_000;

export type GateScope = "public" | "sadran";

export interface WatchRegistration {
  departmentId: string;
  weeks: readonly string[];
  scope: GateScope;
  /** May this viewer's reads be fully described by this scope's counter? (A manager on a public-scope screen is not.) */
  gate: boolean;
}

interface Entry extends WatchRegistration {
  /** The counter has been read successfully at least once: a baseline exists. */
  ready: boolean;
}

const entries = new Set<Entry>();

/** Registers a mounted watcher; the returned handle marks it ready after its first good check and unregisters it. */
export function registerWatch(registration: WatchRegistration): { markReady(): void; unregister(): void } {
  const entry: Entry = { ...registration, ready: false };
  entries.add(entry);
  return {
    markReady: () => {
      entry.ready = true;
    },
    unregister: () => {
      entries.delete(entry);
    },
  };
}

/** Tests only. */
export function resetCounterGate(): void {
  entries.clear();
}

/** `["sadran", dept, week, <family>]`: the board's week reads the counter fully covers. */
const SADRAN_GATED = new Set<unknown>(["boardRides", "requestsWithNames", "proposals", "heldNotices", "publicationReadiness", "freedOffers"]);

function watched(department: unknown, week: unknown, scope?: GateScope): boolean {
  for (const entry of entries) {
    if (!entry.ready || !entry.gate || entry.departmentId !== department || !entry.weeks.includes(week as string)) continue;
    if (scope === undefined || entry.scope === scope) return true;
  }
  return false;
}

/** Is this query's data fully described by the counter of a week a mounted watcher covers? */
export function isCounterGated(key: QueryKey): boolean {
  const [root, family] = key;
  if (root === "siddur") {
    if (family === "boardRides") return watched(key[2], key[3]);
    // The scoped form (one week, no `fromWeek`); the Inbox's unscoped block spans weeks and polls.
    if (family === "rideChanges") return key[3] !== undefined && key[4] !== undefined && key[5] === undefined && watched(key[3], key[4]);
    return false;
  }
  if (root === "waitlist") return watched(family, key[2]);
  if (root === "sadran") return SADRAN_GATED.has(key[3]) && watched(family, key[2], "sadran");
  return false;
}

/** True when the focus refetch of this query is skipped: counter-covered and younger than the safety cap. */
export function gatesFocusRefetch(query: Pick<Query, "queryKey" | "state">, now: number = Date.now()): boolean {
  if (!isCounterGated(query.queryKey)) return false;
  const updatedAt = query.state.dataUpdatedAt;
  return updatedAt > 0 && now - updatedAt < GATE_MAX_AGE_MS;
}
