import { describe, expect, it } from "vitest";

import type { TemplateSuggestion } from "./api";
import { toInstant } from "./mapper";
import { suggestionToFormValues } from "./templatePrefill";

const WEEK_START = "2027-01-10"; // Sunday

function baseRow(overrides: Partial<TemplateSuggestion> = {}): TemplateSuggestion {
  return {
    templateId: "template-1",
    departmentId: "dept-1",
    weekStart: WEEK_START,
    destinationId: "dest-1",
    destinationText: null,
    destinationName: "עפולה",
    rideTypeId: "ride-type-1",
    rideTypeName: "אחר",
    tripShape: "round_trip",
    departDow: 2,
    departTime: "08:00:00",
    returnDow: 2,
    returnTime: "12:00:00",
    departAt: toInstant("2027-01-12", "08:00", false),
    returnAt: toInstant("2027-01-12", "12:00", false),
    oneWayCarMode: null,
    needsCarAtDestination: true,
    adults: 2,
    childSeats: 0,
    boosters: 1,
    childIds: ["child-1"],
    companionIds: ["companion-1"],
    hasLuggage: false,
    flexDepartEarly: "00:00:00",
    flexDepartLate: "00:15:00",
    flexReturnEarly: "00:00:00",
    flexReturnLate: "00:00:00",
    preferredCarId: "car-1",
    rideDescription: "נסיעה לעפולה",
    guestPassengerNames: ["אורח"],
    notes: "הערה",
    ...overrides,
  };
}

describe("suggestionToFormValues", () => {
  it("maps a round-trip suggestion into full form values, switch on", () => {
    const values = suggestionToFormValues(baseRow(), WEEK_START);

    expect(values.departmentId).toBe("dept-1");
    expect(values.weekStart).toBe(WEEK_START);
    expect(values.day).toBe("2027-01-12");
    expect(values.dayIndex).toBe(2);
    expect(values.destination).toEqual({ presetId: "dest-1", name: "עפולה" });
    expect(values.rideTypeId).toBe("ride-type-1");
    expect(values.tripShape).toBe("round_trip");
    expect(values.departTime).toBe("08:00");
    expect(values.returnTime).toBe("12:00");
    expect(values.needsCarAtDestination).toBe(true);
    expect(values.adults).toBe(2);
    expect(values.boosters).toBe(1);
    expect(values.childSeats).toBe(1);
    expect(values.legacyChildSeats).toBe(0);
    expect(values.companions).toEqual(["companion-1"]);
    expect(values.children).toEqual(["child-1"]);
    expect(values.flexDepartLate).toBe(15);
    expect(values.preferredCarId).toBe("car-1");
    expect(values.rideDescription).toBe("נסיעה לעפולה");
    expect(values.guestNames).toBe("אורח");
    expect(values.notes).toBe("הערה");
    expect(values.repeatWeekly).toBe(true);
  });

  it("falls back to free-text destination when no preset is linked", () => {
    const values = suggestionToFormValues(baseRow({ destinationId: null, destinationText: "מקום כלשהו", destinationName: null }), WEEK_START);
    expect(values.destination).toEqual({ freeText: "מקום כלשהו" });
  });

  it("maps a one-way-to suggestion (no return leg)", () => {
    const values = suggestionToFormValues(
      baseRow({
        tripShape: "one_way_to",
        oneWayCarMode: "relay",
        returnDow: null,
        returnTime: null,
        returnAt: null,
      }),
      WEEK_START,
    );
    expect(values.returnTime).toBeUndefined();
    expect(values.departTime).toBe("08:00");
    expect(values.oneWayCarMode).toBe("relay");
  });

  it("falls back to weekStart's Sunday when neither leg has an instant", () => {
    const values = suggestionToFormValues(baseRow({ departAt: null, returnAt: null }), WEEK_START);
    expect(values.day).toBe(WEEK_START);
    expect(values.dayIndex).toBe(0);
  });
});
