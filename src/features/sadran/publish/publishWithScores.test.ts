import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseInput, makeCar, makeRequest, slotMs } from "@/solver/__fixtures__/gen";

const mocks = vi.hoisted(() => ({
  fetchDepartments: vi.fn(),
  fetchActivePolicy: vi.fn(),
  fetchPolicyOptions: vi.fn(),
  fetchPublishFingerprint: vi.fn(),
  publishSiddur: vi.fn(),
  gatherSolverContext: vi.fn(),
}));

vi.mock("@/features/siddur/api", () => ({ fetchDepartments: mocks.fetchDepartments }));
vi.mock("../api", () => ({
  fetchActivePolicy: mocks.fetchActivePolicy,
  fetchPolicyOptions: mocks.fetchPolicyOptions,
  fetchPublishFingerprint: mocks.fetchPublishFingerprint,
  publishSiddur: mocks.publishSiddur,
}));
vi.mock("../applySolve", () => ({ gatherSolverContext: mocks.gatherSolverContext, servedOf: vi.fn() }));

import { publishWithScores } from "./publishWithScores";

describe("publishWithScores", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.fetchDepartments.mockResolvedValue([{ id: "dept", home_destination_id: "home" }]);
    mocks.fetchActivePolicy.mockResolvedValue({ policyId: "policy", policyVersionId: "version", versionNo: 1, rules: [] });
    mocks.fetchPolicyOptions.mockResolvedValue([{ policyId: "policy", policyVersionId: "version", versionNo: 1, name: "Policy", rules: [] }]);
    mocks.fetchPublishFingerprint.mockResolvedValue("unchanged");
    mocks.publishSiddur.mockResolvedValue("published-version");
  });

  it("publishes with empty score snapshots when retrospective scoring cannot run", async () => {
    // The per-policy failure is logged on purpose (never silent) — keep it out of the test output.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.gatherSolverContext.mockRejectedValue(new Error("legacy request cannot be scored"));

    await expect(publishWithScores("dept", "2026-09-13")).resolves.toBe("published-version");
    expect(mocks.publishSiddur).toHaveBeenCalledWith("dept", "2026-09-13", [], "unchanged", [], {});
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("keeps a working policy's score when a sibling policy fails to score, and logs the failure", async () => {
    mocks.fetchActivePolicy.mockResolvedValue({ policyId: "good", policyVersionId: "good-v", versionNo: 1, rules: [] });
    mocks.fetchPolicyOptions.mockResolvedValue([
      { policyId: "good", policyVersionId: "good-v", versionNo: 1, name: "Good", rules: [] },
      { policyId: "bad", policyVersionId: "bad-v", versionNo: 1, name: "Bad", rules: [] },
    ]);
    const goodInput = baseInput({ cars: [makeCar("car")], requests: [makeRequest({ id: "r1", memberId: "m1", departureMs: slotMs(32), returnMs: slotMs(40) })], policy: { id: "good", version: 1, rules: [] } });
    mocks.gatherSolverContext.mockImplementation(async ({ policy }: { policy: { policyId: string } }) => {
      if (policy.policyId === "bad") throw new Error("boom");
      return { input: goodInput, boardRides: [] };
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(publishWithScores("dept", "2026-09-13")).resolves.toBe("published-version");

    const policyScoresArg = mocks.publishSiddur.mock.calls[0]?.[4];
    expect(policyScoresArg).toHaveLength(1);
    expect(policyScoresArg[0].policy_id).toBe("good");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("bad"), expect.any(Error));
    errorSpy.mockRestore();
  });
});
