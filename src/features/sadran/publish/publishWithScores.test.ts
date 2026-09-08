import { beforeEach, describe, expect, it, vi } from "vitest";

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
    mocks.gatherSolverContext.mockRejectedValue(new Error("legacy request cannot be scored"));

    await expect(publishWithScores("dept", "2026-09-13")).resolves.toBe("published-version");
    expect(mocks.publishSiddur).toHaveBeenCalledWith("dept", "2026-09-13", [], "unchanged", [], {});
  });
});
