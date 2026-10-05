import { describe, expect, it } from "vitest";

import { canUseDrivingTripTypes, initialTripType, tripTypeToLegacyFields } from "./tripType";

describe("tripTypeToLegacyFields", () => {
  it("round_trip", () => {
    expect(tripTypeToLegacyFields("round_trip", false)).toEqual({
      tripShape: "round_trip",
      needsCarAtDestination: true,
      oneWayCarMode: undefined,
    });
  });

  it("one_way is always relay", () => {
    expect(tripTypeToLegacyFields("one_way", false)).toEqual({
      tripShape: "one_way_to",
      needsCarAtDestination: true,
      oneWayCarMode: "relay",
    });
  });

  it("drop_off without pickup is a plain one-way-to leg", () => {
    expect(tripTypeToLegacyFields("drop_off", false)).toEqual({
      tripShape: "one_way_to",
      needsCarAtDestination: false,
      oneWayCarMode: undefined,
    });
  });

  it("drop_off with pickup is a round trip without the car at destination", () => {
    expect(tripTypeToLegacyFields("drop_off", true)).toEqual({
      tripShape: "round_trip",
      needsCarAtDestination: false,
      oneWayCarMode: undefined,
    });
  });
});

describe("initialTripType", () => {
  it("prefers the stored trip_type column", () => {
    expect(initialTripType({ tripType: "one_way", tripShape: "one_way_to", needsCarAtDestination: true })).toEqual({
      tripType: "one_way",
      dropOffPickup: false,
    });
    expect(initialTripType({ tripType: "drop_off", tripShape: "round_trip", needsCarAtDestination: false })).toEqual({
      tripType: "drop_off",
      dropOffPickup: true,
    });
  });

  it("falls back to the shape-based derivation when trip_type is missing", () => {
    expect(initialTripType({ tripShape: "round_trip", needsCarAtDestination: true })).toEqual({
      tripType: "round_trip",
      dropOffPickup: false,
    });
    expect(initialTripType({ tripShape: "round_trip", needsCarAtDestination: false })).toEqual({
      tripType: "drop_off",
      dropOffPickup: true,
    });
    expect(initialTripType({ tripShape: "one_way_to", needsCarAtDestination: true })).toEqual({
      tripType: "one_way",
      dropOffPickup: false,
    });
    expect(initialTripType({ tripShape: "one_way_from", needsCarAtDestination: true })).toEqual({
      tripType: "drop_off",
      dropOffPickup: false,
    });
  });
});

describe("canUseDrivingTripTypes", () => {
  it("is always true for a driving member", () => {
    expect(canUseDrivingTripTypes(false, [], new Map())).toBe(true);
  });

  it("is false for a non-driver with no driving companion selected", () => {
    expect(canUseDrivingTripTypes(true, [], new Map())).toBe(false);
    expect(canUseDrivingTripTypes(true, ["a"], new Map([["a", true]]))).toBe(false);
  });

  it("is true for a non-driver with at least one driving companion selected", () => {
    expect(canUseDrivingTripTypes(true, ["a", "b"], new Map([["a", true], ["b", false]]))).toBe(true);
  });
});
