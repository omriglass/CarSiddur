import type { Json } from "@/integrations/supabase/types";

import type { FreedOfferCandidate } from "../api";

/** REQ §13.168: one option as the Sadran sees it — who rides, in order, and whether it can still be given. */
export interface FreedOptionRow {
  key: string;
  requestIds: string[];
  people: FreedOfferCandidate[];
  recommended: boolean;
  /** Someone in it stepped out — the option can no longer be given. */
  blocked: boolean;
  planB: number;
}

interface StoredOption {
  request_ids?: unknown;
  recommended?: unknown;
}

/**
 * The offer's stored options (ranked by the edge function, `freed_slot_offers.options`) joined with its candidates.
 * An offer made before options existed has none: every open candidate is then its own option, in claim order.
 */
export function freedOptionRows(options: Json | null | undefined, candidates: readonly FreedOfferCandidate[]): FreedOptionRow[] {
  const byId = new Map(candidates.map((c) => [c.requestId, c]));
  const stored = Array.isArray(options) ? (options as StoredOption[]) : [];
  const lists: { ids: string[]; recommended: boolean }[] = stored.length > 0
    ? stored.map((o) => ({ ids: Array.isArray(o.request_ids) ? (o.request_ids as string[]) : [], recommended: o.recommended === true }))
    : candidates.filter((c) => c.claimStatus === "offered" || c.claimStatus === "claimed").map((c, i) => ({ ids: [c.requestId], recommended: i === 0 }));
  return lists
    .filter((o) => o.ids.length > 0 && o.ids.every((id) => byId.has(id)))
    .map((o) => {
      const people = o.ids.map((id) => byId.get(id)!).sort((a, b) => (a.departAt ?? "").localeCompare(b.departAt ?? ""));
      return {
        key: o.ids.join(","),
        requestIds: o.ids,
        people,
        recommended: o.recommended,
        blocked: people.some((p) => p.claimStatus === "withdrawn" || p.claimStatus === "declined"),
        planB: people.filter((p) => p.planB).length,
      };
    });
}

/** The candidates the Sadran may still tick for a discussion (not stepped out). */
export function openFreedCandidates(candidates: readonly FreedOfferCandidate[]): FreedOfferCandidate[] {
  return candidates
    .filter((c) => c.claimStatus === "offered" || c.claimStatus === "claimed")
    .sort((a, b) => (a.departAt ?? "").localeCompare(b.departAt ?? "") || a.requestId.localeCompare(b.requestId));
}
