// Owner 2026-11-17 ("every time I reopen the app it reloads everything"): the screens a member opens on - the siddur,
// "my rides", requests, the inbox, who I am - are saved on this device too, beside the catalogs (`catalogPersist.ts`).
// On the next open they are put back at once (marked out of date, so every screen re-reads its own at once) and a
// "מסנכרן…" toast stays until the screens on show have their fresh copy. Saved per member and app version, wiped on
// sign-out, at most MAX_AGE_MS old. The Sadran's board data is not saved (large; it loads fresh).
import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";

import type { StorageLike } from "./catalogPersist";
import { queryTier } from "./queryPolicy";

export const SESSION_STORAGE_KEY = "carshare.sessionCache.v1";
export const SESSION_MAX_AGE_MS = 3 * 24 * 60 * 60_000;
const WRITE_DEBOUNCE_MS = 3_000;
const MAX_ENTRY_CHARS = 400_000;
const MAX_TOTAL_CHARS = 2_500_000;
/** A screen that never gets its fresh copy (offline) still drops the toast after this long; the error toasts say why. */
const SYNC_TOAST_CAP_MS = 45_000;

const SAVED_ROOTS = new Set<unknown>(["siddur", "requests", "rides", "inbox", "auth", "context", "member", "waitlist", "carTasks"]);

/** Saved: a member-facing family, not a catalog (`catalogPersist` keeps those). */
export function isSessionSaved(key: QueryKey): boolean {
  return SAVED_ROOTS.has(key[0]) && queryTier(key) !== "catalog";
}

/** Only data that comes back the same from JSON (no Map, Set, Date, class instance). */
export function isPlainJson(value: unknown, depth = 0): boolean {
  if (depth > 40) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isPlainJson(item, depth + 1));
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value as Record<string, unknown>).every((item) => item === undefined || isPlainJson(item, depth + 1));
  }
  return false;
}

interface SavedEntry { key: QueryKey; data: unknown; at: number }
interface SavedSession { owner: string; version: string; entries: SavedEntry[] }

interface Runtime {
  client: QueryClient;
  storage: StorageLike;
  version: string;
  owner: string | null;
  /** Hydrated from the saved copy and not re-read yet: hash -> when the saved data was read from the server. */
  restored: Map<string, number>;
  restoredAt: number;
  writeTimer: ReturnType<typeof setTimeout> | null;
  listeners: Set<() => void>;
  syncing: boolean;
}

let runtime: Runtime | null = null;

function computeSyncing(rt: Runtime): boolean {
  if (!rt.restored.size || Date.now() - rt.restoredAt > SYNC_TOAST_CAP_MS) return false;
  for (const hash of rt.restored.keys()) {
    const query = rt.client.getQueryCache().get(hash);
    // on show and being re-read (a query switched off on this screen is not waited for)
    if (query && query.getObserversCount() > 0 && query.state.fetchStatus === "fetching") return true;
  }
  return false;
}

function refreshSyncing(rt: Runtime): void {
  const next = computeSyncing(rt);
  if (next === rt.syncing) return;
  rt.syncing = next;
  for (const listener of rt.listeners) listener();
}

/** The saved copy as it would be written now. */
export function snapshotSession(client: QueryClient, owner: string, version: string, restored: ReadonlyMap<string, number> = new Map()): SavedSession {
  const entries: SavedEntry[] = [];
  let total = 0;
  const queries = client.getQueryCache().getAll()
    .filter((query) => query.state.status === "success" && query.state.data !== undefined && isSessionSaved(query.queryKey))
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
  for (const query of queries) {
    if (!isPlainJson(query.state.data)) continue;
    const size = JSON.stringify(query.state.data).length;
    if (size > MAX_ENTRY_CHARS || total + size > MAX_TOTAL_CHARS) continue;
    total += size;
    entries.push({ key: query.queryKey, data: query.state.data, at: restored.get(query.queryHash) ?? query.state.dataUpdatedAt });
  }
  return { owner, version, entries };
}

function readSession(storage: StorageLike, owner: string, version: string): SavedSession | null {
  try {
    const raw = storage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedSession;
    if (parsed?.owner !== owner || parsed.version !== version || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Puts the saved entries back, out of date (a screen re-reads its own on mount). Returns hash -> saved time. */
export function hydrateSession(client: QueryClient, saved: SavedSession, now: number): Map<string, number> {
  const restored = new Map<string, number>();
  for (const entry of saved.entries) {
    if (!Array.isArray(entry?.key) || typeof entry.at !== "number" || entry.data === undefined || !isSessionSaved(entry.key)) continue;
    if (now - entry.at > SESSION_MAX_AGE_MS || entry.at > now) continue;
    if (client.getQueryState(entry.key)?.data !== undefined) continue; // the live value wins
    client.setQueryData(entry.key, entry.data, { updatedAt: 1 });
    const query = client.getQueryCache().find({ queryKey: entry.key, exact: true });
    if (query) restored.set(query.queryHash, entry.at);
  }
  return restored;
}

function write(rt: Runtime): void {
  rt.writeTimer = null;
  if (!rt.owner) return;
  try {
    rt.storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(snapshotSession(rt.client, rt.owner, rt.version, rt.restored)));
  } catch {
    try { rt.storage.removeItem(SESSION_STORAGE_KEY); } catch { /* blocked storage */ }
  }
}

/** Call once, right after the QueryClient is created. */
export function initSessionPersistence(client: QueryClient, version: string, storage: StorageLike | null = safeLocalStorage()): void {
  if (!storage || runtime) return;
  const rt: Runtime = { client, storage, version, owner: null, restored: new Map(), restoredAt: 0, writeTimer: null, listeners: new Set(), syncing: false };
  runtime = rt;
  client.getQueryCache().subscribe((event) => {
    const query: Query = event.query;
    if (event.type === "updated" && (event.action.type === "success" || event.action.type === "error")) {
      rt.restored.delete(query.queryHash);
      if (event.action.type === "success" && rt.owner && rt.writeTimer === null && isSessionSaved(query.queryKey)) {
        rt.writeTimer = setTimeout(() => write(rt), WRITE_DEBOUNCE_MS);
      }
    }
    if (rt.restored.size || rt.syncing) refreshSyncing(rt);
  });
}

/** Call with the signed-in member (null = signed out) BEFORE the screens mount - next to `setCatalogOwner`. */
export function setSessionOwner(owner: string | null): void {
  const rt = runtime;
  if (!rt || rt.owner === owner) return;
  rt.owner = owner;
  rt.restored.clear();
  if (!owner) {
    try { rt.storage.removeItem(SESSION_STORAGE_KEY); } catch { /* blocked storage */ }
    refreshSyncing(rt);
    return;
  }
  const saved = readSession(rt.storage, owner, rt.version);
  if (!saved) return;
  rt.restored = hydrateSession(rt.client, saved, Date.now());
  rt.restoredAt = Date.now();
  // the screens mount after this; look again once they have, and once the cap has passed
  setTimeout(() => refreshSyncing(rt), 0);
  setTimeout(() => refreshSyncing(rt), SYNC_TOAST_CAP_MS + 100);
}

/** For `useSyncExternalStore`: true while a screen on show still shows the saved copy. */
export function subscribeSyncing(listener: () => void): () => void {
  runtime?.listeners.add(listener);
  return () => { runtime?.listeners.delete(listener); };
}
export function isSyncing(): boolean {
  return runtime?.syncing ?? false;
}

function safeLocalStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Tests only. */
export function resetSessionPersistenceForTests(): void {
  if (runtime?.writeTimer) clearTimeout(runtime.writeTimer);
  runtime = null;
}
