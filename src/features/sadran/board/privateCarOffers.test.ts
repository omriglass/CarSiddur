import { describe, expect, it } from "vitest";
import type { SolverOutput } from "@/solver";
import { withoutPrivateCarOffers } from "./privateCarOffers";
import { privateCarBlocks } from "./dropValidity";

const base = { reasonCode: "X", reason: "x", cost: 1, confidence: 1 };
const output = { assignments: [], unmet: [{ requestId: "r1", score: 1, blockers: [], reasonCode: "X", reason: "x", suggestions: [
  { ...base, requestId: "r1", kind: "shiftBeyondFlex", carId: "priv", window: { start: 0, end: 1 }, shift: { departureMin: 0, returnMin: 0 } },
  { ...base, requestId: "r1", kind: "merge", hostRideId: "h", guestRequestIds: ["r1"], leg: "both", proposedDriverRequestId: "r1", window: { start: 0, end: 1 }, detourMinutes: 0, detourKm: 0 },
  { ...base, requestId: "r1", kind: "deny" },
] }] } as unknown as SolverOutput;
const cars = [{ id: "priv", type: "temporary", owner_id: "owner" }, { id: "pub", type: "shared", owner_id: null }];

describe("private car rule (QB20)", () => {
  it("drops suggestions that target a private car for a non-owner", () => {
    const rides = [{ id: "h", car_id: "pub" }];
    const kinds = withoutPrivateCarOffers(output, cars, rides, [{ id: "r1", requester_id: "u" }]).unmet[0]!.suggestions.map((s) => s.kind);
    expect(kinds).toEqual(["merge", "deny"]);
    expect(withoutPrivateCarOffers(output, cars, rides, [{ id: "r1", requester_id: "owner" }]).unmet[0]!.suggestions).toHaveLength(3);
  });
  it("keeps a merge into the owner own private car", () => {
    const kinds = withoutPrivateCarOffers(output, cars, [{ id: "h", car_id: "priv" }], [{ id: "r1", requester_id: "owner" }]).unmet[0]!.suggestions.map((s) => s.kind);
    expect(kinds).toContain("merge");
  });
  it("privateCarBlocks: only the owner may place", () => {
    const ctx = { cars } as never;
    expect(privateCarBlocks(ctx, "priv", "u")).toBe(true);
    expect(privateCarBlocks(ctx, "priv", "owner")).toBe(false);
    expect(privateCarBlocks(ctx, "pub", "u")).toBe(false);
  });
});
