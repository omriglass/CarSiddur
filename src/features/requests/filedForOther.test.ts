import { describe, expect, it } from "vitest";

import { isFiledForOther, ownRequestIds } from "./filedForOther";

const ME = "me";

describe("isFiledForOther (REQ §13.177 c)", () => {
  it("is a request I filed for someone else", () => {
    expect(isFiledForOther({ filedById: ME, requesterId: "dana" }, ME)).toBe(true);
  });
  it("is not my own request, nor one I filed for myself", () => {
    expect(isFiledForOther({ filedById: ME, requesterId: ME }, ME)).toBe(false);
    expect(isFiledForOther({ filedById: null, requesterId: ME }, ME)).toBe(false);
  });
  it("is not one I filed and ride on as a companion", () => {
    expect(isFiledForOther({ filedById: ME, requesterId: "dana", companionIds: [ME] }, ME)).toBe(false);
  });
  it("is not someone else's request I am named on", () => {
    expect(isFiledForOther({ filedById: "dana", requesterId: "dana", companionIds: [ME] }, ME)).toBe(false);
  });
  it("ownRequestIds leaves the filed-for-others out", () => {
    expect([...ownRequestIds([{ id: "a", filedById: ME, requesterId: "dana" }, { id: "b", filedById: ME, requesterId: ME }], ME)]).toEqual(["b"]);
  });
});
