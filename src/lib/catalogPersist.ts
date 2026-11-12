// PF1 (docs/PF1_PLAN_2026-11.md §11): the catalog-tier queries (cars, seat configs, destinations, ride types,
// department settings, active policy, WhatsApp templates, own profile - `queryPolicy.ts`) survive a page reload.
//
// A reload used to re-read all of them at once with the screen's heavy calls. Now they are saved on this device
// (localStorage) and put back before the first screen mounts:
//   - saved less than CATALOG_STALE_MS ago: used as is - the same freshness the app already allows in memory;
//   - older (up to MAX_AGE_MS): shown at once and re-read `REVALIDATE_AFTER_MS` later, after the screen's own
//     calls, so nothing stays out of date for longer than that;
//   - a different member, a different app version or an unreadable entry: discarded.
// Only catalog-tier keys are saved - never rides, requests, members or permissions. RLS still decides what the
// re-read returns; sign-out clears the saved copy.
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { CATALOG_STALE_MS, queryTier } from "./queryPolicy";

export const STORAGE_KEY = "carshare.catalogCache.v1";
export const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
export const REVALIDATE_AFTER_MS = 8_000;
const WRITE_DEBOUNCE_MS = 2_000;
const MAX_BYTES = 1_500_000;

export interface SavedEntry { key: QueryKey; data: unknown; at: number }
export interface SavedCatalogs { owner: string; version: string; entries: SavedEntry[] }

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The saved copy, or null when it belongs to someone else / another version / is unreadable. */
export function readSaved(storage: StorageLike, owner: string, version: string): SavedCatalogs | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedCatalogs;
    if (parsed?.owner !== owner || parsed.version !== version || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Puts saved catalog entries back. Returns the keys that are older than the catalog freshness and need a re-read. */
export function hydrate(client: QueryClient, saved: SavedCatalogs, now: number): QueryKey[] {
  const overdue: QueryKey[] = [];
  for (const entry of saved.entries) {
    if (!Array.isArray(entry?.key) || typeof entry.at !== "number" || entry.data === undefined) continue;
    if (queryTier(entry.key) !== "catalog") continue; // a key reclassified since it was saved
    const age = now - entry.at;
    if (age < 0 || age > MAX_AGE_MS) continue;
    if (client.getQueryState(entry.key)?.data !== undefined) continue; // the live value wins
    const fresh = age < CATALOG_STALE_MS;
    // An overdue entry is shown as current for the first seconds only; `overdue` is re-read right after.
    client.setQueryData(entry.key, entry.data, { updatedAt: fresh ? entry.at : now });
    if (!fresh) overdue.push(entry.key);
  }
  return overdue;
}

/** Every successful catalog-tier query now in the cache. `skip`: keys whose shown value is an old saved copy. */
export function snapshot(client: QueryClient, owner: string, version: string, skip: ReadonlySet<string> = new Set()): SavedCatalogs {
  const entries: SavedEntry[] = [];
  for (const query of client.getQueryCache().getAll()) {
    if (query.state.status !== "success" || query.state.data === undefined) continue;
    if (queryTier(query.queryKey) !== "catalog" || skip.has(query.queryHash)) continue;
    entries.push({ key: query.queryKey, data: query.state.data, at: query.state.dataUpdatedAt });
  }
  return { owner, version, entries };
}

interface Runtime {
  client: QueryClient;
  storage: StorageLike;
  version: string;
  owner: string | null;
  /** Hashes of entries hydrated from an old copy and not yet re-read: never saved with a new timestamp. */
  awaitingReread: Set<string>;
  writeTimer: ReturnType<typeof setTimeout> | null;
  rereadTimer: ReturnType<typeof setTimeout> | null;
}

let runtime: Runtime | null = null;

function write(rt: Runtime): void {
  rt.writeTimer = null;
  if (!rt.owner) return;
  try {
    const text = JSON.stringify(snapshot(rt.client, rt.owner, rt.version, rt.awaitingReread));
    if (text.length > MAX_BYTES) rt.storage.removeItem(STORAGE_KEY);
    else rt.storage.setItem(STORAGE_KEY, text);
  } catch {
    // Storage full or blocked: the app works without the saved copy.
  }
}

/** Call once, right after the QueryClient is created. */
export function initCatalogPersistence(client: QueryClient, version: string, storage: StorageLike | null = safeLocalStorage()): void {
  if (!storage || runtime) return;
  const rt: Runtime = { client, storage, version, owner: null, awaitingReread: new Set(), writeTimer: null, rereadTimer: null };
  runtime = rt;
  client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success") return;
    if (queryTier(event.query.queryKey) !== "catalog") return;
    rt.awaitingReread.delete(event.query.queryHash);
    if (rt.owner && rt.writeTimer === null) rt.writeTimer = setTimeout(() => write(rt), WRITE_DEBOUNCE_MS);
  });
}

/** Call when the signed-in member is known or changes (null = signed out), BEFORE the screens mount. */
export function setCatalogOwner(owner: string | null): void {
  const rt = runtime;
  if (!rt || rt.owner === owner) return;
  rt.owner = owner;
  rt.awaitingReread.clear();
  if (rt.rereadTimer) { clearTimeout(rt.rereadTimer); rt.rereadTimer = null; }
  if (!owner) {
    try { rt.storage.removeItem(STORAGE_KEY); } catch { /* blocked storage */ }
    return;
  }
  const saved = readSaved(rt.storage, owner, rt.version);
  if (!saved) return;
  const overdue = hydrate(rt.client, saved, Date.now());
  if (overdue.length === 0) return;
  for (const key of overdue) {
    const query = rt.client.getQueryCache().find({ queryKey: key, exact: true });
    if (query) rt.awaitingReread.add(query.queryHash);
  }
  rt.rereadTimer = setTimeout(() => {
    rt.rereadTimer = null;
    for (const key of overdue) void rt.client.invalidateQueries({ queryKey: key, exact: true });
  }, REVALIDATE_AFTER_MS);
}

function safeLocalStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Tests only. */
export function resetCatalogPersistenceForTests(): void {
  if (runtime?.writeTimer) clearTimeout(runtime.writeTimer);
  if (runtime?.rereadTimer) clearTimeout(runtime.rereadTimer);
  runtime = null;
}
