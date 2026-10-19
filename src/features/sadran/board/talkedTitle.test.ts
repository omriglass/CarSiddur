import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";

import { talkedTitle } from "./talkedTitle";

describe("talkedTitle", () => {
  it("names every distinct person once", () => {
    const title = talkedTitle(["A", " B ", "A", ""]);
    expect(title).toContain("A, B");
    expect(title).not.toContain("A, B, A");
  });
  it("falls back to a neutral title", () => {
    expect(talkedTitle([])).toBe(he.boardDrafts.talkedTitleNoName);
    expect(talkedTitle(["  "])).toBe(he.boardDrafts.talkedTitleNoName);
  });
});
