import { describe, expect, it } from "vitest";
import { baseInput, makeRequest, makeCar, slotMs } from "@/solver/__fixtures__/gen";
import { calculateProfileScores, summarizePolicyScore } from "./profileScores";

describe("publication policy scores", () => {
  const r1 = makeRequest({ id: "r1", memberId: "m1", departureMs: slotMs(32), returnMs: slotMs(40), manualBoost: { value: 0.2, reason: "test" } });
  const r2 = makeRequest({ id: "r2", memberId: "m1", departureMs: slotMs(44), returnMs: slotMs(48), manualBoost: { value: 0.5, reason: "test" } });
  const input = baseInput({ cars: [makeCar("car")], requests: [r1, r2], policy: {
    id: "policy", version: 1, rules: [{ type: "manualBoost", weight: 1, params: {} }],
  } });
  it("keeps priority scores stable while manual assignment changes served totals", () => {
    const before = calculateProfileScores(input, new Set(["r1"]))[0]!;
    const after = calculateProfileScores(input, new Set(["r2"]))[0]!;
    expect(after.priority_total).toBe(before.priority_total);
    expect(after.served_priority_total).toBeGreaterThan(before.served_priority_total);
    expect(after.request_count).toBe(2);
    expect(after.served_count).toBe(1);
    expect(after.requests[1]?.breakdown[0]?.type).toBe("manualBoost");
  });
  it("includes fixed rides in scoring and keeps deterministic profile/request order", () => {
    const expected = calculateProfileScores(input, new Set(["r1"]));
    const actual = calculateProfileScores({ ...input, requests: [r2, r1], fixedRides: [{ id: "fixed", servedRequestIds: ["r1"] } as never] }, new Set(["r1"]));
    expect(actual).toEqual(expected);
  });
  it("rejects malformed or unknown rules instead of saving partial scores", () => {
    expect(() => calculateProfileScores({ ...input, policy: { ...input.policy, rules: [{ type: "futureRule", weight: 1, params: {} }] } }, new Set())).toThrow();
  });
  it("compares the same manual board against different policy profiles", () => {
    const assigned = new Set(["r1"]);
    const weighted = summarizePolicyScore({ policyId: "p1", policyVersionId: "v1", name: "Priority" }, calculateProfileScores(input, assigned));
    const equal = summarizePolicyScore({ policyId: "p2", policyVersionId: "v2", name: "Equal" }, calculateProfileScores({ ...input,
      policy: { id: "p2", version: 1, rules: [{ type: "rideType", weight: 1, params: { weights: { other: 1 } } }] },
    }, assigned));
    expect(weighted.served_count).toBe(equal.served_count);
    expect(weighted.alignment_ratio).toBeCloseTo(2 / 7, 6);
    expect(equal.alignment_ratio).toBe(0.5);
    expect(weighted.policy_version_id).toBe("v1");
  });
});
