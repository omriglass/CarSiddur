import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";

import { isKeepCarRow, keepCarActive, keepCarNote, keepCarOffered, keepCarTripLabel } from "./keepCar";
import { initialTripType } from "./tripType";

describe("keepCarOffered", () => {
  const base = { tripType: "round_trip" as const, day: "2026-10-12" };
  it("only for a driver's single-day round trip", () => {
    expect(keepCarOffered(base, true)).toBe(true);
    expect(keepCarOffered(base, false)).toBe(false);
    expect(keepCarOffered({ ...base, tripType: "one_way" }, true)).toBe(false);
    expect(keepCarOffered({ ...base, tripType: "drop_off" }, true)).toBe(false);
    expect(keepCarOffered({ ...base, returnDay: "2026-10-13" }, true)).toBe(false);
    expect(keepCarOffered({ ...base, returnDay: "2026-10-12" }, true)).toBe(true);
  });
});

describe("keepCarActive", () => {
  const base = { tripType: "round_trip" as const, tripShape: "round_trip" as const, day: "2026-10-12", keepCarAtDestination: true };
  it("needs the flag on a single-day round trip outside window mode", () => {
    expect(keepCarActive(base)).toBe(true);
    expect(keepCarActive({ ...base, keepCarAtDestination: false })).toBe(false);
    expect(keepCarActive({ ...base, tripType: "one_way", tripShape: "one_way_to" })).toBe(false);
    expect(keepCarActive({ ...base, returnDay: "2026-10-14" })).toBe(false);
    expect(keepCarActive({ ...base, timeMode: "window" })).toBe(false);
  });
});

describe("labels and loading", () => {
  it("reads as a round trip with a note, never הקפצה", () => {
    expect(keepCarTripLabel("חיפה")).toBe(`${he.request.tripTypeRoundTrip} · הרכב נשאר בחיפה`);
    expect(keepCarTripLabel("חיפה")).not.toContain(he.request.tripTypeDropOff);
    expect(keepCarNote("")).toBe(he.keepCar.noteNoPlace);
  });
  it("a stored drop_off + flag opens as a round trip with no pickup switch", () => {
    const row = { tripType: "drop_off" as const, tripShape: "round_trip" as const, needsCarAtDestination: false, keepCarAtDestination: true };
    expect(isKeepCarRow(row)).toBe(true);
    expect(initialTripType(row)).toEqual({ tripType: "round_trip", dropOffPickup: false });
    expect(isKeepCarRow({ ...row, keepCarAtDestination: false })).toBe(false);
    expect(initialTripType({ ...row, keepCarAtDestination: false }).tripType).toBe("drop_off");
  });
});
