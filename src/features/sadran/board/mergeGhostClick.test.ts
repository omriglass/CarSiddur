import { describe, expect, it } from "vitest";

import { mergeGhostTarget } from "./mergeGhostClick";

const proposals = [
  { id: "p-sent", status: "sent", ride_id: "ride-1" },
  { id: "p-accepted", status: "accepted", ride_id: "ride-2" },
  { id: "p-draft", status: "draft", ride_id: "ride-3" },
  { id: "p-orphan", status: "sent", ride_id: null },
];

describe("mergeGhostTarget (R8U2)", () => {
  it("opens the host ride for a merge waiting for an answer", () => {
    expect(mergeGhostTarget(proposals, "merge:p-sent")).toEqual({ kind: "ride", rideId: "ride-1" });
    expect(mergeGhostTarget(proposals, "merge:p-accepted")).toEqual({ kind: "ride", rideId: "ride-2" });
  });
  it("keeps the draft's own action sheet", () => {
    expect(mergeGhostTarget(proposals, "merge:p-draft")).toEqual({ kind: "proposal", proposalId: "p-draft" });
  });
  it("falls back to the proposal when the ride is unknown", () => {
    expect(mergeGhostTarget(proposals, "merge:p-orphan")).toEqual({ kind: "proposal", proposalId: "p-orphan" });
    expect(mergeGhostTarget(proposals, "merge:nope")).toEqual({ kind: "proposal", proposalId: "nope" });
  });
});
