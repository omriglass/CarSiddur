import { describe, expect, it } from "vitest";

import type { UseFormReturn } from "react-hook-form";

import { canSwapPlaces, dropOffMode, nonDriverStart, swapRequestPlaces } from "./dropOffMode";

import type { RequestFormValues } from "./schema";

const home = { presetId: "home", name: "גבעת חביבה" };
const binyamina = { presetId: "bin", name: "בנימינה" };

describe("dropOffMode (REQ §13.181 c)", () => {
  it("reads the explicit choice first", () => {
    expect(dropOffMode({ dropOffPickup: true, pickupOnly: undefined, origin: home, destination: binyamina }, "home")).toBe("both");
    expect(dropOffMode({ dropOffPickup: false, pickupOnly: true, origin: home, destination: binyamina }, "home")).toBe("pickup");
    expect(dropOffMode({ dropOffPickup: false, pickupOnly: false, origin: binyamina, destination: home }, "home")).toBe("drop");
  });
  it("derives a pickup from a one-way הקפצה that ends at the base place", () => {
    expect(dropOffMode({ dropOffPickup: false, pickupOnly: undefined, origin: binyamina, destination: home }, "home")).toBe("pickup");
    expect(dropOffMode({ dropOffPickup: false, pickupOnly: undefined, origin: home, destination: binyamina }, "home")).toBe("drop");
    expect(dropOffMode({ dropOffPickup: false, pickupOnly: undefined, origin: binyamina, destination: home }, null)).toBe("drop");
  });
});

describe("swapRequestPlaces (REQ §13.181 b)", () => {
  it("swaps the places and turns the stops around", () => {
    const values = { origin: home, destination: binyamina, outStops: [{ freeText: "a" }, { freeText: "b" }], returnStops: [{ freeText: "c" }] } as Record<string, unknown>;
    const form = {
      getValues: () => ({ ...values }),
      setValue: (name: string, value: unknown) => { values[name] = value; },
    } as unknown as UseFormReturn<RequestFormValues>;
    swapRequestPlaces(form);
    expect([values.origin, values.destination]).toEqual([binyamina, home]);
    expect(values.outStops).toEqual([{ freeText: "c" }]);
    expect(values.returnStops).toEqual([{ freeText: "b" }, { freeText: "a" }]);
  });
  it("is offered only when both places are chosen", () => {
    expect(canSwapPlaces({ origin: home, destination: binyamina })).toBe(true);
    expect(canSwapPlaces({ origin: home, destination: { freeText: " " } })).toBe(false);
  });
});

describe("nonDriverStart (ND1)", () => {
  it("both legs when the hours are more than an hour apart", () => {
    expect(nonDriverStart("08:00", "12:00")).toEqual({ mode: "both", arriveBy: "08:00", pickupAt: "12:00" });
  });
  it("one leg when an hour or less apart: a drop-off before 13:00, a pickup from 13:00 on", () => {
    expect(nonDriverStart("09:00", "10:00")).toMatchObject({ mode: "drop", arriveBy: "09:00" });
    expect(nonDriverStart("12:45", "13:30")).toMatchObject({ mode: "drop" });
    expect(nonDriverStart("13:00", "14:00")).toEqual({ mode: "pickup", arriveBy: "13:00", pickupAt: "13:00" });
    expect(nonDriverStart("16:00", undefined)).toMatchObject({ mode: "pickup", pickupAt: "16:00" });
  });
});
