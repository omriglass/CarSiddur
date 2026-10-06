import { describe, expect, it } from "vitest";

import { childOverlapMessage } from "./childOverlap";

describe("childOverlapMessage", () => {
  it("names the child, the other parent and the Jerusalem time span", () => {
    const text = childOverlapMessage({
      childName: "Dana",
      requesterName: "Avi",
      departAt: "2026-10-12T05:00:00Z",
      returnAt: "2026-10-12T07:30:00Z",
    });
    expect(text).toContain("Dana");
    expect(text).toContain("Avi");
    expect(text).toContain("08:00–10:30");
  });
});
