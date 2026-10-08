import { describe, expect, it } from "vitest";

import { shouldSuggestChildcare } from "./childcareType";

const types = [
  { id: "w", code: "work" },
  { id: "c", code: "childcare" },
  { id: "o", code: "other" },
];

describe("shouldSuggestChildcare", () => {
  it("switches the untouched default to the childcare type", () => {
    expect(shouldSuggestChildcare({ rideTypes: types, currentRideTypeId: "o", touched: false, isNew: true })).toBe("c");
  });
  it("never overrides a type the member picked, or a request being edited", () => {
    expect(shouldSuggestChildcare({ rideTypes: types, currentRideTypeId: "o", touched: true, isNew: true })).toBeNull();
    expect(shouldSuggestChildcare({ rideTypes: types, currentRideTypeId: "w", touched: false, isNew: true })).toBeNull();
    expect(shouldSuggestChildcare({ rideTypes: types, currentRideTypeId: "o", touched: false, isNew: false })).toBeNull();
  });
  it("does nothing without a childcare type", () => {
    expect(shouldSuggestChildcare({ rideTypes: [types[0]!, types[2]!], currentRideTypeId: "o", touched: false, isNew: true })).toBeNull();
  });
});
