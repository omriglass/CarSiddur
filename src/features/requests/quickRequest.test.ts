import { describe, expect, it } from "vitest";
import { coverNamedPassengers, guestPassengerNames, quickVehicleWindow, resolveQuickOrigin } from "./quickRequest";

describe("quick live requests", () => {
  it("covers the requester and named people without dropping unnamed passengers or existing child seats", () => {
    expect(coverNamedPassengers({ adults: 1, childSeats: 0, boosters: 0 }, 2)).toEqual({ adults: 3, childSeats: 0, boosters: 0 });
    expect(coverNamedPassengers({ adults: 1, childSeats: 1, boosters: 1 }, 2)).toEqual({ adults: 1, childSeats: 1, boosters: 1 });
    expect(coverNamedPassengers({ adults: 5, childSeats: 0, boosters: 0 }, 1).adults).toBe(5);
    expect(coverNamedPassengers({ adults: 1, childSeats: 0, boosters: 0 }, 10).adults).toBe(8);
  });
  it("keeps individual guest names, trimming blank lines without combining different people", () => {
    expect(guestPassengerNames("  Guest One \n\nGuest Two\r\n ")).toEqual(["Guest One", "Guest Two"]);
  });
  it("reserves both legs and dwell, rounding up to quarter hours anchored on departure or arrival home", () => {
    const hour = 60 * 60_000;
    expect(quickVehicleWindow("one_way_to", 10 * hour, 14 * hour, 30, 10)).toEqual({ startMs: 10 * hour, endMs: 11.25 * hour });
    expect(quickVehicleWindow("one_way_from", 10 * hour, 14 * hour, 30, 10)).toEqual({ startMs: 8.75 * hour, endMs: 10 * hour });
    expect(quickVehicleWindow("one_way_to", 10 * hour, 14 * hour, 45, 20)).toEqual({ startMs: 10 * hour, endMs: 12 * hour });
  });
  it("preserves 23:59 arrival while rounding the volunteer's start down to a quarter hour", () => {
    const arrival = Date.parse("2044-01-03T23:59:00+02:00");
    expect(quickVehicleWindow("one_way_from", arrival, 0, 30, 10)).toEqual({
      startMs: Date.parse("2044-01-03T22:30:00+02:00"), endMs: arrival,
    });
  });
  it("retains explicit round-trip duration instead of applying chauffeur travel estimation", () => {
    expect(quickVehicleWindow("round_trip", 100, 200, 90, 20)).toEqual({ startMs: 100, endMs: 200 });
  });
  it("reserves at least one slot and clamps negative configured travel and dwell independently", () => {
    expect(quickVehicleWindow("one_way_to", 0, 0, 0, 0)).toEqual({ startMs: 0, endMs: 15 * 60_000 });
    expect(quickVehicleWindow("one_way_from", 0, 0, -30, -10)).toEqual({ startMs: -15 * 60_000, endMs: 0 });
    expect(quickVehicleWindow("one_way_to", 0, 0, 30, -10)).toEqual({ startMs: 0, endMs: 60 * 60_000 });
    expect(quickVehicleWindow("one_way_to", 0, 0, -30, 20)).toEqual({ startMs: 0, endMs: 30 * 60_000 });
  });
});

describe("resolveQuickOrigin (REQ §13.93)", () => {
  const base = { carId: "car-1", atMs: 1000, awayWindows: [], homeId: "home", homeName: "נבו" } as const;

  it("uses an away window covering the slot's start", () => {
    expect(
      resolveQuickOrigin({
        ...base,
        awayWindows: [{ carId: "car-1", awayFrom: "1970-01-01T00:00:00.500Z", awayUntil: null, locationId: "x", locationName: "כפר סבא" }],
      }),
    ).toEqual({ presetId: "x", name: "כפר סבא" });
  });

  it("ignores an away window for a different car or outside its range", () => {
    expect(
      resolveQuickOrigin({
        ...base,
        awayWindows: [{ carId: "car-2", awayFrom: "1970-01-01T00:00:00.000Z", awayUntil: null, locationId: "x" }],
      }),
    ).toEqual({ presetId: "home", name: "נבו" });
    expect(
      resolveQuickOrigin({
        ...base,
        awayWindows: [{ carId: "car-1", awayFrom: "1970-01-01T00:00:02.000Z", awayUntil: null, locationId: "x" }],
      }),
    ).toEqual({ presetId: "home", name: "נבו" });
  });

  it("falls back to the car's base location, else home", () => {
    expect(resolveQuickOrigin({ ...base, baseLocationId: "base-1", baseLocationName: "חדרה" })).toEqual({
      presetId: "base-1",
      name: "חדרה",
    });
    expect(resolveQuickOrigin(base)).toEqual({ presetId: "home", name: "נבו" });
  });
});
