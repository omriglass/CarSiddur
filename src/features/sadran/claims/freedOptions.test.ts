import { describe, expect, it } from "vitest";

import type { FreedOfferCandidate } from "../api";
import { freedOptionRows, openFreedCandidates } from "./freedOptions";

const cand = (requestId: string, departAt: string, extra: Partial<FreedOfferCandidate> = {}): FreedOfferCandidate => ({
  requestId, profileId: `p-${requestId}`, name: requestId, claimStatus: "offered", planB: false, departAt, returnAt: departAt, ...extra,
});

describe("freedOptionRows (REQ §13.168)", () => {
  const candidates = [cand("w2", "2026-11-03T17:00:00Z"), cand("w1", "2026-11-03T08:00:00Z"), cand("p", "2026-11-03T05:00:00Z", { planB: true })];

  it("keeps the stored ranking, orders each option's people by time and counts plan-B moves", () => {
    const rows = freedOptionRows([
      { request_ids: ["w2", "w1"], recommended: true },
      { request_ids: ["p", "w2"], recommended: false },
    ], candidates);
    expect(rows.map((r) => r.people.map((p) => p.requestId))).toEqual([["w1", "w2"], ["p", "w2"]]);
    expect(rows[0]?.recommended).toBe(true);
    expect(rows[1]?.planB).toBe(1);
  });

  it("blocks an option once someone in it stepped out; drops options naming unknown requests", () => {
    const stepped = candidates.map((c) => (c.requestId === "w2" ? { ...c, claimStatus: "withdrawn" as const } : c));
    const rows = freedOptionRows([{ request_ids: ["w1", "w2"], recommended: true }, { request_ids: ["w1"] }, { request_ids: ["ghost"] }], stepped);
    expect(rows.map((r) => [r.key, r.blocked])).toEqual([["w1,w2", true], ["w1", false]]);
    expect(openFreedCandidates(stepped).map((c) => c.requestId)).toEqual(["p", "w1"]);
  });

  it("an offer from before options existed lists each open candidate alone, the first one recommended", () => {
    const rows = freedOptionRows([], candidates);
    expect(rows.map((r) => r.key)).toEqual(["w2", "w1", "p"]);
    expect(rows.filter((r) => r.recommended)).toHaveLength(1);
  });
});
