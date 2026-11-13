import { describe, expect, it } from "vitest";

import { carOwnerIds, flattenCarOwners, isCarOwner } from "./carOwners";

describe("car owners (PC1)", () => {
  it("every listed owner of a private car is an owner", () => {
    const car = { type: "temporary", owner_id: "a", owner_ids: ["a", "b"] };
    expect(isCarOwner(car, "a")).toBe(true);
    expect(isCarOwner(car, "b")).toBe(true);
    expect(isCarOwner(car, "c")).toBe(false);
    expect(isCarOwner(car, undefined)).toBe(false);
  });

  it("falls back to owner_id when the owners were not read; a shared car has none", () => {
    expect(carOwnerIds({ type: "temporary", owner_id: "a" })).toEqual(["a"]);
    expect(carOwnerIds({ type: "temporary", owner_id: null, owner_ids: [] })).toEqual([]);
    expect(isCarOwner({ type: "shared", owner_id: null, owner_ids: ["a"] }, "a")).toBe(false);
  });

  it("flattens the embed", () => {
    expect(flattenCarOwners({ id: "x", owners: [{ profile_id: "a" }, { profile_id: "b" }] })).toEqual({ id: "x", owner_ids: ["a", "b"] });
    expect(flattenCarOwners({ id: "x", owners: null })).toEqual({ id: "x", owner_ids: [] });
  });
});
