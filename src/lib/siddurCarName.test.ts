import { describe, expect, it } from "vitest";

import { tv } from "@/i18n/he";

import { siddurCarName, siddurCarParts } from "./siddurCarName";

describe("siddurCarName", () => {
  it("adds the active code", () => {
    expect(siddurCarName({ name: "A", access_code: "0123" })).toBe(tv("siddurCar.withCode", { name: "A", code: "⁦0123⁩" }));
    // REQ item 264: a replacement with no code shows its name alone, never the regular car's code.
    expect(siddurCarName({ name: "A", access_code: "0123", is_replaced: true, replacement_code: null }))
      .toBe(tv("siddurCar.replacementName", { name: "A" }));
    expect(siddurCarName({ name: "A", access_code: "0123", is_replaced: true, replacement_code: "4567" }))
      .toBe(tv("siddurCar.withCode", { name: tv("siddurCar.replacementName", { name: "A" }), code: "⁦4567⁩" }));
  });

  it("splits the label so a narrow header can keep the code on its own line", () => {
    expect(siddurCarParts({ name: "A", access_code: "0123", is_replaced: true, replacement_code: "4567" }))
      .toEqual({ name: "A", replaced: true, code: "4567" });
    expect(siddurCarParts({ name: "A", access_code: "0123", is_replaced: true, replacement_code: null }).code).toBeNull();
  });

  it("shows the name alone for a car with no code", () => {
    expect(siddurCarName({ name: "A", access_code: null })).toBe("A");
  });
});
