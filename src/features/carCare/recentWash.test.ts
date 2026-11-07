import { describe, expect, it } from "vitest";

import { recentWashSinceKey, recentlyWashedCarIds } from "./recentWash";

describe("recently washed", () => {
  // Wed 2026-11-04 12:00 Jerusalem: this week's Sunday is 11-01, last week's 10-25.
  const now = new Date("2026-11-04T10:00:00Z");
  it("uses last week's Sunday", () => {
    expect(recentWashSinceKey(now)).toBe("2026-10-25");
  });
  it("includes washes since then, excludes older", () => {
    const ids = recentlyWashedCarIds(
      [
        { car_id: "a", created_at: "2026-10-25T05:00:00Z" },
        { car_id: "b", created_at: "2026-10-24T20:00:00Z" },
        { car_id: "c", created_at: "2026-11-03T08:00:00Z" },
      ],
      now,
    );
    expect([...ids].sort()).toEqual(["a", "c"]);
  });
});
