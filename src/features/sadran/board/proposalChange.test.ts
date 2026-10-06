import { describe, expect, it } from "vitest";

import { proposalChangeLines } from "./proposalChange";

const request = { depart_at: "2026-10-15T04:15:00Z", return_at: "2026-10-15T11:30:00Z" };

describe("proposalChangeLines (R5U1)", () => {
  it("states old -> new times and car for a shift", () => {
    const lines = proposalChangeLines({ type: "shift", payload: { car_id: "c", depart_at: "2026-10-15T04:15:00Z", return_at: "2026-10-15T12:30:00Z" }, request, oldCarName: "פיג'ו", newCarName: "קורולה" });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("במקום");
    expect(lines[1]).toContain("קורולה");
    expect(lines[1]).toContain("פיג'ו");
  });
  it("says the times do not change when only the car does", () => {
    const lines = proposalChangeLines({ type: "shift", payload: { car_id: "c", return_at: "2026-10-15T11:30:00Z" }, request, newCarName: "קורולה" });
    expect(lines[0]).not.toContain("במקום");
    expect(lines[1]).toContain("קורולה");
  });
  it("a merge reads the joiner's times from the server preview", () => {
    const lines = proposalChangeLines({
      type: "merge", payload: {}, request: { depart_at: "2026-10-13T03:45:00Z", return_at: null }, newCarName: "קורולה",
      server: { ok: true, code: null, newStartsAt: "2026-10-13T04:00:00Z", newEndsAt: "2026-10-13T05:30:00Z", joinerDepartAt: "2026-10-13T04:00:00Z", joinerReturnAt: null },
    });
    expect(lines[0]).toContain("07:00");
    expect(lines[0]).toContain("06:45");
  });
  it("deny / external / origin have nothing to compare", () => {
    expect(proposalChangeLines({ type: "deny", payload: {}, request })).toEqual([]);
  });
});
