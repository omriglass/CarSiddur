// src/features/sadran/dashboard/needsAttention.ts
//
// Derives the week dashboard's "דורש טיפול" list (UX_FLOWS.md §4.1) from
// already-fetched rows. Pure data shaping — no Supabase, no Hebrew (the
// dashboard screen maps each `kind` to `he.sadran.needsAttention.*` and fills
// in the count/names); kept here so the ordering and "only show non-empty
// sections" rule is unit-testable without a DB.

export type NeedsAttentionKind =
  | "lateRequests"
  | "changedRequests"
  | "expiringProposals"
  | "chauffeurNeeded"
  | "carsAwayAtDayEnd"
  | "maintenanceAffecting"
  | "contestedClaims";

export interface NeedsAttentionSection {
  kind: NeedsAttentionKind;
  count: number;
  /** Identifying details the screen needs to render/link each row (car names, ride ids, …). */
  ids: string[];
}

export interface NeedsAttentionInput {
  lateRequestIds: readonly string[];
  changedRequestIds: readonly string[];
  /** Sent proposals expiring within the dashboard's warning window (e.g. 6h). */
  expiringProposalIds: readonly string[];
  /** Unmet requests whose only path forward is a chauffeur (needs a driver assigned). */
  chauffeurNeededRequestIds: readonly string[];
  /** Car ids away from home at day end without an acknowledgement. */
  carsAwayAtDayEndIds: readonly string[];
  /** Ride ids affected by a maintenance block that starts before the week ends. */
  maintenanceAffectedRideIds: readonly string[];
  /** Freed-slot offer ids with more than one live claim. */
  contestedOfferIds: readonly string[];
}

/**
 * Order matches the UX_FLOWS.md §4.1 wireframe (late -> changed -> expiring
 * proposals -> chauffeur needed -> cars away -> maintenance -> contested
 * claims); a section with `count === 0` is omitted entirely.
 */
export function deriveNeedsAttention(input: NeedsAttentionInput): NeedsAttentionSection[] {
  const candidates: NeedsAttentionSection[] = [
    { kind: "lateRequests", count: input.lateRequestIds.length, ids: [...input.lateRequestIds] },
    { kind: "changedRequests", count: input.changedRequestIds.length, ids: [...input.changedRequestIds] },
    { kind: "expiringProposals", count: input.expiringProposalIds.length, ids: [...input.expiringProposalIds] },
    { kind: "chauffeurNeeded", count: input.chauffeurNeededRequestIds.length, ids: [...input.chauffeurNeededRequestIds] },
    { kind: "carsAwayAtDayEnd", count: input.carsAwayAtDayEndIds.length, ids: [...input.carsAwayAtDayEndIds] },
    { kind: "maintenanceAffecting", count: input.maintenanceAffectedRideIds.length, ids: [...input.maintenanceAffectedRideIds] },
    { kind: "contestedClaims", count: input.contestedOfferIds.length, ids: [...input.contestedOfferIds] },
  ];
  return candidates.filter((section) => section.count > 0);
}
