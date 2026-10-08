import { describe, expect, it, vi } from "vitest";
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
  it("tolerates an unknown or malformed rule instead of throwing, warning to the console", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const profiles = calculateProfileScores({ ...input, policy: { ...input.policy, rules: [{ type: "futureRule", weight: 1, params: {} }] } }, new Set());
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.request_count).toBe(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("policy"), expect.anything());
    warnSpy.mockRestore();
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
  it("scores every original request: free-text origins and series legs included (QB18)", () => {
    const free = makeRequest({ id: "free", memberId: "m2", departureMs: slotMs(32), returnMs: slotMs(40), originIsFreeText: true });
    const s1 = makeRequest({ id: "s1", memberId: "m3", departureMs: slotMs(32), returnMs: slotMs(96), seriesId: "S", seriesIndex: 1, seriesCount: 2 });
    const s2 = makeRequest({ id: "s2", memberId: "m3", departureMs: slotMs(96), returnMs: slotMs(120), seriesId: "S", seriesIndex: 2, seriesCount: 2 });
    const profiles = calculateProfileScores({ ...input, requests: [r1, free, s1, s2] }, new Set(["r1"]));
    expect(profiles.flatMap((p) => p.requests.map((q) => q.request_id)).sort()).toEqual(["free", "r1", "s1", "s2"]);
  });
  it("a request served by its plan B counts the policy's alternativeServedWeight (default 0.1) of its priority (REQ §13.112 a)", () => {
    const plain = calculateProfileScores(input, new Set(["r1"]))[0]!;
    const viaPlanB = calculateProfileScores({ ...input, requests: [{ ...r1, servedByAlternative: true }, r2] }, new Set(["r1"]))[0]!;
    expect(viaPlanB.priority_total).toBe(plain.priority_total);
    expect(viaPlanB.served_count).toBe(1);
    expect(viaPlanB.served_priority_total).toBeCloseTo(plain.served_priority_total * 0.1, 6);
    expect(viaPlanB.requests.find((q) => q.request_id === "r1")?.weight).toBe(0.1);
    expect(viaPlanB.requests.find((q) => q.request_id === "r2")?.weight).toBeUndefined();
    const custom = calculateProfileScores({ ...input, requests: [{ ...r1, servedByAlternative: true }, r2],
      policy: { ...input.policy, rules: [...input.policy.rules, { type: "fairness", weight: 0, params: { lookbackWeeks: 3, alternativeServedWeight: 0.5 } }] } }, new Set(["r1"]))[0]!;
    expect(custom.requests.find((q) => q.request_id === "r1")?.weight).toBe(0.5);
  });
});

describe("plan B pair counts once (REQ §13.112 a)", () => {
  it("the pickup-leg sibling weighs 0 while its parent weighs the plan B weight", () => {
    const base = makeRequest({ id: "p1", memberId: "m1", departureMs: slotMs(32), returnMs: slotMs(40) });
    const input2 = baseInput({ cars: [makeCar("car")], requests: [{ ...base, servedByAlternative: true }, makeRequest({ id: "p2", memberId: "m1", departureMs: slotMs(60), returnMs: slotMs(64), servedByAlternative: true, planBSibling: true })] });
    const rows = calculateProfileScores(input2, new Set(["p1", "p2"]))[0]!.requests;
    expect(rows.find((r) => r.request_id === "p1")?.weight).toBe(0.1);
    expect(rows.find((r) => r.request_id === "p2")?.weight).toBe(0);
  });
});
