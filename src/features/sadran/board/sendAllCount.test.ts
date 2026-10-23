import { describe, expect, it } from "vitest";

import { sendAllCount } from "./sendAllCount";

describe("sendAllCount", () => {
  it("uses the singular form for exactly one", () => {
    for (const key of ["dayProposals", "dayUpdates", "weekUpdates"] as const) {
      expect(sendAllCount(key, 1)).not.toMatch(/\d/);
    }
  });
  it("prints the number otherwise", () => {
    expect(sendAllCount("dayProposals", 3)).toContain("3");
    expect(sendAllCount("dayUpdates", 2)).toContain("2");
  });
});
