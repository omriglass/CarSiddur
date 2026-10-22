import { describe, expect, it } from "vitest";

import { tv } from "@/i18n/he";

import { siddurCarName } from "./siddurCarName";

describe("siddurCarName", () => {
  it("adds the active code", () => {
    expect(siddurCarName({ name: "A", access_code: "0123" })).toBe(tv("siddurCar.withCode", { name: "A", code: "⁦0123⁩" }));
    expect(siddurCarName({ name: "A", access_code: "0123", is_replaced: true, replacement_code: "4567" }))
      .toBe(tv("siddurCar.withCode", { name: tv("siddurCar.replacementName", { name: "A" }), code: "⁦4567⁩" }));
  });

  it("shows the name alone for a car with no code", () => {
    expect(siddurCarName({ name: "A", access_code: null })).toBe("A");
  });
});
