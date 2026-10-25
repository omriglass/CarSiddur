import { describe, expect, it } from "vitest";

import { changelogIds, evaluateChangelog } from "./changelog-check.mjs";

const file = (...ids) => ids.map((id) => `  {\n    id: "${id}",\n    date: "2026-10-19",\n  },`).join("\n");

describe("changelog-check", () => {
  it("reads entry ids in order", () => {
    expect(changelogIds(file("b", "a"))).toEqual(["b", "a"]);
  });
  it("passes when the top entry is new since the last release", () => {
    expect(evaluateChangelog(file("a"), file("b", "a")).ok).toBe(true);
    expect(evaluateChangelog("", file("a")).ok).toBe(true);
  });
  it("lets a release without a new entry through as a quiet minor release", () => {
    expect(evaluateChangelog(file("a"), file("a"))).toMatchObject({ ok: true, minor: true });
    expect(evaluateChangelog(file("a"), file("b", "a"))).toMatchObject({ ok: true, minor: false });
  });
  it("refuses a new entry that is not on top", () => {
    expect(evaluateChangelog(file("a"), file("a", "b")).ok).toBe(false);
  });
});
