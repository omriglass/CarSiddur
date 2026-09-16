import { describe, expect, it } from "vitest";

import { landingPathFor, mainPageOf } from "./landing";

describe("landing page", () => {
  it("defaults to the siddur when nothing is remembered or the value is unknown", () => {
    expect(landingPathFor(null)).toBe("/siddur");
    expect(landingPathFor(undefined)).toBe("/siddur");
    expect(landingPathFor("/admin")).toBe("/siddur");
  });

  it("returns the remembered main page", () => {
    expect(landingPathFor("/my")).toBe("/my");
    expect(landingPathFor("/siddur")).toBe("/siddur");
  });

  it("recognises only the two main pages, including deep siddur routes", () => {
    expect(mainPageOf("/my")).toBe("/my");
    expect(mainPageOf("/siddur")).toBe("/siddur");
    expect(mainPageOf("/siddur/dept-1/2026-09-13")).toBe("/siddur");
    expect(mainPageOf("/requests/new")).toBeNull();
    expect(mainPageOf("/sadran/dept-1/2026-09-13/board")).toBeNull();
  });
});
