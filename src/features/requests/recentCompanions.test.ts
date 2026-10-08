import { describe, expect, it } from "vitest";

import { recentCompanionIds } from "./recentCompanions";

describe("recentCompanionIds", () => {
  it("lists distinct companions newest request first, without the member and capped", () => {
    const rows = [
      { profileId: "a", at: "2026-10-01T08:00:00Z" },
      { profileId: "b", at: "2026-10-05T08:00:00Z" },
      { profileId: "me", at: "2026-10-06T08:00:00Z" },
      { profileId: "a", at: "2026-10-04T08:00:00Z" },
      { profileId: "c", at: null },
    ];
    expect(recentCompanionIds(rows, "me")).toEqual(["b", "a", "c"]);
    expect(recentCompanionIds(rows, "me", 2)).toEqual(["b", "a"]);
  });

  it("is empty without history", () => {
    expect(recentCompanionIds([], "me")).toEqual([]);
  });
});
