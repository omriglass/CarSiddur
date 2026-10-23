import { describe, expect, it } from "vitest";

import { expiresAtPublish } from "./expiresAtPublish";

describe("expiresAtPublish (R13B10, mirrors expire_proposals)", () => {
  it("keeps only a Sadran-made shift or merge", () => {
    expect(expiresAtPublish({ type: "shift", created_via: "sadran" })).toBe(false);
    expect(expiresAtPublish({ type: "merge", created_via: "sadran" })).toBe(false);
  });

  it("expires origin, alternative, deny and external proposals, and anything not made by the Sadran", () => {
    for (const type of ["origin", "alternative", "deny", "external"]) expect(expiresAtPublish({ type, created_via: "sadran" })).toBe(true);
    expect(expiresAtPublish({ type: "merge", created_via: "member" })).toBe(true);
  });
});
