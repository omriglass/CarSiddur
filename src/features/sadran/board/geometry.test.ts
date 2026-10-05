import { describe, expect, it } from "vitest";

import {
  awayLocationAt,
  isHandoverPair,
  isoToMinutesSinceMidnight,
  isoToSlot,
  scanBoardConflicts,
  tightScheduleRideIds,
  requestDayMismatchRideIds,
  slotToIso,
  snapMinutesTo15,
  withinFlex,
  wouldOverlap,
} from "./geometry";

const WEEK_START_MS = Date.parse("2026-09-13T00:00:00.000Z");

describe("isoToSlot / slotToIso", () => {
  it("round-trips a 15-minute-aligned timestamp", () => {
    const iso = new Date(WEEK_START_MS + 5 * 15 * 60_000).toISOString();
    expect(isoToSlot(iso, WEEK_START_MS)).toBe(5);
    expect(slotToIso(5, WEEK_START_MS)).toBe(iso);
  });

  it("rounds a near-boundary timestamp to the nearest slot", () => {
    const iso = new Date(WEEK_START_MS + 15 * 60_000 - 10).toISOString();
    expect(isoToSlot(iso, WEEK_START_MS)).toBe(1);
  });
});

describe("isoToMinutesSinceMidnight", () => {
  it("computes minutes since a given day start", () => {
    const dayStart = "2026-09-15T00:00:00.000Z";
    const at = "2026-09-15T08:30:00.000Z";
    expect(isoToMinutesSinceMidnight(at, dayStart)).toBe(510);
  });
});

describe("snapMinutesTo15", () => {
  it("snaps to the nearest quarter hour", () => {
    expect(snapMinutesTo15(7)).toBe(0);
    expect(snapMinutesTo15(8)).toBe(15);
    expect(snapMinutesTo15(97)).toBe(90);
  });
});

describe("withinFlex", () => {
  it("no shift is always within flex", () => {
    expect(withinFlex(0, 0, 0)).toBe(true);
  });
  it("checks earlier/later bounds independently", () => {
    expect(withinFlex(-30, 30, 15)).toBe(true);
    expect(withinFlex(-31, 30, 15)).toBe(false);
    expect(withinFlex(15, 30, 15)).toBe(true);
    expect(withinFlex(16, 30, 15)).toBe(false);
  });
  it("'day' flexibility accepts any shift in that direction", () => {
    expect(withinFlex(-10_000, "day", 0)).toBe(true);
    expect(withinFlex(10_000, 0, "day")).toBe(true);
  });
});

describe("wouldOverlap", () => {
  it("detects overlap within the buffer", () => {
    const candidate = { startsAt: "2026-09-15T08:00:00.000Z", endsAt: "2026-09-15T09:00:00.000Z" };
    const others = [{ startsAt: "2026-09-15T09:10:00.000Z", endsAt: "2026-09-15T10:00:00.000Z" }];
    expect(wouldOverlap(candidate, others, 30)).toBe(true);
    expect(wouldOverlap(candidate, others, 5)).toBe(false);
  });
});

const DAYS = Array.from({ length: 7 }, (_, dayIndex) => ({
  dayIndex: dayIndex as 0 | 1 | 2 | 3 | 4 | 5 | 6,
  startSlot: dayIndex * 96,
  endSlot: dayIndex * 96 + 96,
  dayEndSlot: dayIndex * 96 + 95,
}));

function iso(dayOffsetMs: number): string {
  return new Date(WEEK_START_MS + dayOffsetMs).toISOString();
}

describe("scanBoardConflicts - reservations (REQ §13.96)", () => {
  const rides = [
    { id: "a", carId: "c", startsAt: iso(8 * 3600_000), endsAt: iso(9 * 3600_000), originId: "home", destinationId: "home" },
    { id: "res", carId: "c", startsAt: iso(10 * 3600_000), endsAt: iso(12 * 3600_000), originId: "haifa", destinationId: "haifa", locationNeutral: true },
    { id: "b", carId: "c", startsAt: iso(13 * 3600_000), endsAt: iso(14 * 3600_000), originId: "home", destinationId: "home" },
  ];
  const scan = (r = rides) => scanBoardConflicts({ rides: r, carIds: ["c"], weekStartMs: WEEK_START_MS, bufferMinutes: 30, homeLocationId: "home", days: DAYS });

  it("a reservation labelled Haifa between two home rides: no chain break, no away band, no conflict", () => {
    const result = scan();
    expect(result.conflictRideIds.size).toBe(0);
    expect(result.chainBreaksByCarId.get("c")).toEqual([]);
    expect(result.awayByCarId.get("c")).toEqual([]);
    expect(result.weekEndAwayByCarId.get("c")).toBeNull();
  });

  it("still conflicts in time with a ride overlapping it", () => {
    const result = scan([...rides, { id: "x", carId: "c", startsAt: iso(11 * 3600_000), endsAt: iso(12.5 * 3600_000), originId: "home", destinationId: "home" }]);
    expect(result.conflictRideIds.has("res")).toBe(true);
  });
});

describe("scanBoardConflicts", () => {
  it("flags two overlapping rides on the same car and leaves a non-overlapping ride clean", () => {
    const rides = [
      {
        id: "r1",
        carId: "car-1",
        startsAt: iso(8 * 3600_000),
        endsAt: iso(9 * 3600_000),
        originId: "home",
        destinationId: "home",
      },
      {
        id: "r2",
        carId: "car-1",
        startsAt: iso(8.5 * 3600_000),
        endsAt: iso(9.5 * 3600_000),
        originId: "home",
        destinationId: "home",
      },
      {
        id: "r3",
        carId: "car-2",
        startsAt: iso(8 * 3600_000),
        endsAt: iso(9 * 3600_000),
        originId: "home",
        destinationId: "home",
      },
    ];
    const result = scanBoardConflicts({
      rides,
      carIds: ["car-1", "car-2"],
      weekStartMs: WEEK_START_MS,
      bufferMinutes: 30,
      homeLocationId: "home",
      days: DAYS,
    });
    expect(result.conflictRideIds.has("r1")).toBe(true);
    expect(result.conflictRideIds.has("r2")).toBe(true);
    expect(result.conflictRideIds.has("r3")).toBe(false);
  });

  it("flags a ride starting where the car is not (location mismatch)", () => {
    const rides = [
      {
        id: "r1",
        carId: "car-1",
        startsAt: iso(8 * 3600_000),
        endsAt: iso(9 * 3600_000),
        originId: "away",
        destinationId: "home",
      },
    ];
    const result = scanBoardConflicts({
      rides,
      carIds: ["car-1"],
      weekStartMs: WEEK_START_MS,
      bufferMinutes: 30,
      homeLocationId: "home",
      days: DAYS,
    });
    expect(result.conflictRideIds.has("r1")).toBe(true);
  });

  it("records a chain break instead of blocking (REQUIREMENTS §13.93 — day-end rule retired)", () => {
    const rides = [
      {
        id: "r1",
        carId: "car-1",
        startsAt: iso(8 * 3600_000),
        endsAt: iso(9 * 3600_000),
        originId: "away",
        destinationId: "home",
      },
    ];
    const result = scanBoardConflicts({
      rides,
      carIds: ["car-1"],
      weekStartMs: WEEK_START_MS,
      bufferMinutes: 30,
      homeLocationId: "home",
      days: DAYS,
    });
    expect(result.chainBreaksByCarId.get("car-1")).toEqual([
      { rideId: "r1", carLocationId: "home", rideOriginId: "away" },
    ]);
  });

  it("reports an away window spanning day end (no day-end warning any more)", () => {
    const rides = [
      {
        id: "r1",
        carId: "car-1",
        startsAt: iso(22 * 3600_000),
        endsAt: iso(23 * 3600_000),
        originId: "home",
        destinationId: "away",
      },
    ];
    const result = scanBoardConflicts({
      rides,
      carIds: ["car-1"],
      weekStartMs: WEEK_START_MS,
      bufferMinutes: 30,
      homeLocationId: "home",
      days: DAYS,
    });
    expect(result.awayByCarId.get("car-1")?.some((a) => a.locationId === "away")).toBe(true);
    // The car never returns within the week in this fixture -> away at week end too.
    expect(result.weekEndAwayByCarId.get("car-1")).toEqual({ locationId: "away" });
  });

  it("away band is relative to the car's own base, continues across days", () => {
    const rides = [
      {
        id: "r1",
        carId: "car-1",
        startsAt: iso(8 * 3600_000),
        endsAt: iso(9 * 3600_000),
        originId: "binyamina",
        destinationId: "home",
      },
    ];
    const result = scanBoardConflicts({
      rides,
      carIds: ["car-1"],
      weekStartMs: WEEK_START_MS,
      bufferMinutes: 30,
      homeLocationId: "home",
      days: DAYS,
      carLocationsById: new Map([["car-1", { baseLocationId: "binyamina", startLocationId: "binyamina" }]]),
    });
    // The car starts and stays at its own (non-home) base until r1 moves it home — that
    // leading stretch is not "away" (it's exactly where it belongs), and the tail after the
    // ride (now at home, not its base) is away, through week end.
    expect(result.chainBreaksByCarId.get("car-1")).toEqual([]);
    const away = result.awayByCarId.get("car-1") ?? [];
    expect(away.some((a) => a.locationId === "binyamina")).toBe(false);
    expect(away.some((a) => a.locationId === "home" && a.window.start === isoToSlot(iso(9 * 3600_000), WEEK_START_MS))).toBe(true);
    expect(result.weekEndAwayByCarId.get("car-1")).toEqual({ locationId: "home" });
  });
});


describe("requestDayMismatchRideIds", () => {
  const requests = [
    { id: "out", trip_shape: "round_trip", depart_at: "2026-09-10T07:00:00Z", return_at: "2026-09-10T12:00:00Z" },
    { id: "back", trip_shape: "one_way_from", depart_at: null, return_at: "2026-09-10T21:30:00Z" },
  ];
  it("flags a legacy wrong-day assignment while permitting an empty reservation", () => {
    expect([...requestDayMismatchRideIds([
      { id: "wrong", starts_at: "2026-09-09T07:00:00Z", served: [{ request_id: "out", leg: "both" }] },
      { id: "correct", starts_at: "2026-09-10T07:00:00Z", served: [{ request_id: "out", leg: "both" }] },
      { id: "reservation", starts_at: "2026-09-09T07:00:00Z", served: [] },
    ], requests)]).toEqual(["wrong"]);
  });
  it("uses the Jerusalem return day rather than UTC day or a missing departure", () => {
    expect([...requestDayMismatchRideIds([
      { id: "return-ok", starts_at: "2026-09-10T21:15:00Z", served: [{ request_id: "back", leg: "return" }] },
      { id: "return-wrong", starts_at: "2026-09-10T18:00:00Z", served: [{ request_id: "back", leg: "return" }] },
    ], requests)]).toEqual(["return-wrong"]);
  });
});

describe("approved tight turnarounds", () => {
  const first = { id: "a", carId: "car", startsAt: iso(8 * 3600_000), endsAt: iso(9 * 3600_000), originId: "home", destinationId: "home" };
  const next = { ...first, id: "b", startsAt: iso(9 * 3600_000), endsAt: iso(10 * 3600_000) };
  const scan = (rides: (typeof first & { turnaroundMinutes?: number })[]) => scanBoardConflicts({ rides, carIds: ["car"], weekStartMs: WEEK_START_MS, bufferMinutes: 30, homeLocationId: "home", days: DAYS });
  it("allows an intentional zero gap while retaining the standard buffer otherwise", () => {
    expect(scan([first, next]).conflictRideIds.has("b")).toBe(true);
    expect(scan([{ ...first, turnaroundMinutes: 0 }, next]).conflictRideIds.size).toBe(0);
    expect(scan([{ ...first, turnaroundMinutes: 15 }, { ...next, startsAt: iso(9.25 * 3600_000) }]).conflictRideIds.size).toBe(0);
  });
  it("still blocks actual overlap even with zero turnaround", () => {
    expect(scan([{ ...first, turnaroundMinutes: 0 }, { ...next, startsAt: iso(8.75 * 3600_000) }]).conflictRideIds.has("b")).toBe(true);
  });
  it("marks both neighbors, ignores other cars and the exact standard boundary", () => {
    const ride = (id: string, start: number, end: number, car_id = "car") => ({ id, car_id, starts_at: iso(start * 3600_000), ends_at: iso(end * 3600_000) });
    expect([...tightScheduleRideIds([ride("b", 9.25, 10), ride("a", 8, 9), ride("c", 10.5, 11), ride("other", 9, 10, "other")], 30)].sort()).toEqual(["a", "b"]);
  });
  it("does not flag consecutive legs of one multi-day series meeting at midnight", () => {
    const leg = (id: string, start: number, end: number, series_id: string | null) => ({ id, car_id: "car", starts_at: iso(start * 3600_000), ends_at: iso(end * 3600_000), series_id });
    // day 1 08:00→23:59, day 2 00:00→23:59 (same series) then an unrelated ride 10 minutes later
    expect([...tightScheduleRideIds([leg("d1", 8, 23.983, "s"), leg("d2", 24, 47.983, "s"), leg("x", 48.15, 49, null)], 30)].sort()).toEqual(["d2", "x"]);
  });
});

describe("manual handover (REQ §13.94, G7)", () => {
  const out = { id: "out", carId: "car", startsAt: iso(8 * 3600_000), endsAt: iso(9 * 3600_000), originId: "home", destinationId: "x" };
  const back = { id: "back", carId: "car", startsAt: iso(9 * 3600_000), endsAt: iso(10 * 3600_000), originId: "x", destinationId: "home" };
  const scan = (rides: (typeof out)[], carLocationsById?: Map<string, { baseLocationId?: string }>) => scanBoardConflicts({ rides, carIds: ["car"], weekStartMs: WEEK_START_MS, bufferMinutes: 30, homeLocationId: "home", days: DAYS, carLocationsById });

  it("recognises a pair that meets away from the car's base", () => {
    expect(isHandoverPair({ destinationId: "x" }, { originId: "x" }, "home")).toBe(true);
    expect(isHandoverPair({ destinationId: "home" }, { originId: "home" }, "home")).toBe(false);
    expect(isHandoverPair({ destinationId: "x" }, { originId: "y" }, "home")).toBe(false);
  });

  it("does not flag a zero-gap handover at X but still flags the same gap at the base", () => {
    expect(scan([out, back]).conflictRideIds.size).toBe(0);
    const atBase = { ...out, destinationId: "home" };
    expect(scan([atBase, { ...back, originId: "home" }]).conflictRideIds.has("back")).toBe(true);
  });

  it("treats a car whose base is X as no handover", () => {
    expect(scan([out, back], new Map([["car", { baseLocationId: "x" }]])).conflictRideIds.has("back")).toBe(true);
  });

  it("still flags an actual overlap at the handover place", () => {
    expect(scan([out, { ...back, startsAt: iso(8.75 * 3600_000) }]).conflictRideIds.has("back")).toBe(true);
  });

  it("does not mark a handover pair tight, but marks the same gap at the base", () => {
    const ride = (id: string, start: number, end: number, origin_id: string, destination_id: string) =>
      ({ id, car_id: "car", starts_at: iso(start * 3600_000), ends_at: iso(end * 3600_000), origin_id, destination_id });
    const options = { homeLocationId: "home" };
    expect([...tightScheduleRideIds([ride("a", 8, 9, "home", "x"), ride("b", 9.1, 10, "x", "home")], 30, options)]).toEqual([]);
    expect([...tightScheduleRideIds([ride("a", 8, 9, "x", "home"), ride("b", 9.1, 10, "home", "x")], 30, options)].sort()).toEqual(["a", "b"]);
    expect([...tightScheduleRideIds([ride("a", 8, 9, "home", "x"), ride("b", 9.1, 10, "x", "home")], 30, { carBaseLocationId: new Map([["car", "x"]]) })].sort()).toEqual(["a", "b"]);
  });
});

describe("awayLocationAt (QB21)", () => {
  const weekStartMs = Date.parse("2026-10-11T00:00:00Z");
  const windows = [{ locationId: "haris", window: { start: 96 * 2 + 8, end: 96 * 2 + 40 } }];
  const names = new Map([["haris", "Haris"]]);
  it("reports the place only on days the car is away at the day start", () => {
    expect(awayLocationAt(windows, weekStartMs, "2026-10-13T06:00:00Z", names)).toBe("Haris");
    expect(awayLocationAt(windows, weekStartMs, "2026-10-11T00:00:00Z", names)).toBeUndefined();
    expect(awayLocationAt(undefined, weekStartMs, "2026-10-13T06:00:00Z", names)).toBeUndefined();
  });
});
