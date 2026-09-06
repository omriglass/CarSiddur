import { describe, expect, it } from "vitest";

import { deriveNeedsAttention, type NeedsAttentionInput } from "./needsAttention";

const EMPTY: NeedsAttentionInput = {
  lateRequestIds: [],
  changedRequestIds: [],
  expiringProposalIds: [],
  chauffeurNeededRequestIds: [],
  carsAwayAtDayEndIds: [],
  maintenanceAffectedRideIds: [],
  contestedOfferIds: [],
};

describe("deriveNeedsAttention", () => {
  it("returns an empty list when nothing needs attention", () => {
    expect(deriveNeedsAttention(EMPTY)).toEqual([]);
  });

  it("omits zero-count sections and keeps only non-empty ones", () => {
    const result = deriveNeedsAttention({
      ...EMPTY,
      lateRequestIds: ["r1", "r2"],
      contestedOfferIds: ["o1"],
    });
    expect(result).toEqual([
      { kind: "lateRequests", count: 2, ids: ["r1", "r2"] },
      { kind: "contestedClaims", count: 1, ids: ["o1"] },
    ]);
  });

  it("preserves the wireframe order regardless of input order", () => {
    const result = deriveNeedsAttention({
      ...EMPTY,
      contestedOfferIds: ["o1"],
      lateRequestIds: ["r1"],
      maintenanceAffectedRideIds: ["m1"],
    });
    expect(result.map((s) => s.kind)).toEqual(["lateRequests", "maintenanceAffecting", "contestedClaims"]);
  });

  it("includes every section when everything is non-empty", () => {
    const result = deriveNeedsAttention({
      lateRequestIds: ["a"],
      changedRequestIds: ["b"],
      expiringProposalIds: ["c"],
      chauffeurNeededRequestIds: ["d"],
      carsAwayAtDayEndIds: ["e"],
      maintenanceAffectedRideIds: ["f"],
      contestedOfferIds: ["g"],
    });
    expect(result).toHaveLength(7);
  });
});
