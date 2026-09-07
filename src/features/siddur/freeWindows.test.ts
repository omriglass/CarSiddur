import { describe, expect, it } from "vitest";

import { computeCarFreeWindows, firstCarFreeNow, isSlotFree, nextFreeWindowForCar, roundUpToQuarterHour } from "./freeWindows";

const DAY_START = Date.parse("2026-09-08T05:00:00+03:00"); // Tuesday, Asia/Jerusalem (+03:00 in September)
const DAY_END = Date.parse("2026-09-09T00:00:00+03:00");
const TURNAROUND_MIN = 30;

function at(hhmm: string): number {
  return Date.parse(`2026-09-08T${hhmm}:00+03:00`);
}

describe("roundUpToQuarterHour", () => {
  it("rounds up to the next 15-minute mark", () => {
    expect(roundUpToQuarterHour(at("08:01"))).toBe(at("08:15"));
    expect(roundUpToQuarterHour(at("08:15"))).toBe(at("08:15"));
    expect(roundUpToQuarterHour(at("08:16"))).toBe(at("08:30"));
  });
});

describe("computeCarFreeWindows", () => {
  it("returns the whole range free when there is nothing on the car", () => {
    const windows = computeCarFreeWindows({
      carId: "car-1",
      rides: [],
      turnaroundMinutes: TURNAROUND_MIN,
      rangeStart: DAY_START,
      rangeEnd: DAY_END,
      now: DAY_START - 60_000, // before the range
    });
    expect(windows).toEqual([{ carId: "car-1", start: DAY_START, end: DAY_END }]);
  });

  it("carves a gap around a ride, reserving the turnaround buffer before the next slot", () => {
    // Ride 08:00-10:00. Buffer 30 min => next free start is 10:30, not 10:00.
    const windows = computeCarFreeWindows({
      carId: "car-1",
      rides: [{ startsAt: "2026-09-08T08:00:00+03:00", endsAt: "2026-09-08T10:00:00+03:00" }],
      turnaroundMinutes: TURNAROUND_MIN,
      rangeStart: DAY_START,
      rangeEnd: DAY_END,
      now: DAY_START - 60_000,
    });
    expect(windows).toEqual([
      { carId: "car-1", start: DAY_START, end: at("07:30") },
      { carId: "car-1", start: at("10:30"), end: DAY_END },
    ]);
  });

  it("shrinks the gap between two rides by the buffer on the trailing edge", () => {
    // Ride A 08:00-09:00, ride B 11:00-12:00. Free gap must end 30 min before B starts.
    const windows = computeCarFreeWindows({
      carId: "car-1",
      rides: [
        { startsAt: "2026-09-08T08:00:00+03:00", endsAt: "2026-09-08T09:00:00+03:00" },
        { startsAt: "2026-09-08T11:00:00+03:00", endsAt: "2026-09-08T12:00:00+03:00" },
      ],
      turnaroundMinutes: TURNAROUND_MIN,
      rangeStart: DAY_START,
      rangeEnd: DAY_END,
      now: DAY_START - 60_000,
    });
    expect(windows).toEqual([
      { carId: "car-1", start: DAY_START, end: at("07:30") },
      { carId: "car-1", start: at("09:30"), end: at("10:30") },
      { carId: "car-1", start: at("12:30"), end: DAY_END },
    ]);
  });

  it("excludes a maintenance block like a ride, with no buffer needed after the range end", () => {
    const windows = computeCarFreeWindows({
      carId: "car-1",
      rides: [],
      maintenanceBlocks: [{ startsAt: "2026-09-08T14:00:00+03:00", endsAt: "2026-09-08T18:00:00+03:00" }],
      turnaroundMinutes: TURNAROUND_MIN,
      rangeStart: DAY_START,
      rangeEnd: DAY_END,
      now: DAY_START - 60_000,
    });
    expect(windows).toEqual([
      { carId: "car-1", start: DAY_START, end: at("13:30") },
      { carId: "car-1", start: at("18:00"), end: DAY_END },
    ]);
  });

  it("excludes an away-from-home window (relay leg elsewhere) even with no ride overlap otherwise", () => {
    const windows = computeCarFreeWindows({
      carId: "car-1",
      rides: [],
      awayWindows: [{ awayFrom: "2026-09-08T09:00:00+03:00", awayUntil: "2026-09-08T13:00:00+03:00" }],
      turnaroundMinutes: TURNAROUND_MIN,
      rangeStart: DAY_START,
      rangeEnd: DAY_END,
      now: DAY_START - 60_000,
    });
    expect(windows).toEqual([
      { carId: "car-1", start: DAY_START, end: at("08:30") },
      { carId: "car-1", start: at("13:00"), end: DAY_END },
    ]);
  });

  it("treats an away window with no known return (awayUntil null) as blocking the rest of the range", () => {
    const windows = computeCarFreeWindows({
      carId: "car-1",
      rides: [],
      awayWindows: [{ awayFrom: "2026-09-08T09:00:00+03:00", awayUntil: null }],
      turnaroundMinutes: TURNAROUND_MIN,
      rangeStart: DAY_START,
      rangeEnd: DAY_END,
      now: DAY_START - 60_000,
    });
    expect(windows).toEqual([{ carId: "car-1", start: DAY_START, end: at("08:30") }]);
  });

  it("clips a window straddling `now` to start at now rounded up to the next 15 minutes", () => {
    const windows = computeCarFreeWindows({
      carId: "car-1",
      rides: [],
      turnaroundMinutes: TURNAROUND_MIN,
      rangeStart: DAY_START,
      rangeEnd: DAY_END,
      now: at("08:07"),
    });
    expect(windows).toEqual([{ carId: "car-1", start: at("08:15"), end: DAY_END }]);
  });

  it("drops a window that is entirely in the past", () => {
    const windows = computeCarFreeWindows({
      carId: "car-1",
      rides: [{ startsAt: "2026-09-08T10:00:00+03:00", endsAt: "2026-09-08T20:00:00+03:00" }],
      turnaroundMinutes: TURNAROUND_MIN,
      rangeStart: DAY_START,
      rangeEnd: DAY_END,
      now: at("09:00"),
    });
    // The morning gap (05:00-09:30, buffer-shrunk before the 10:00 ride) still has room after
    // clipping to now (09:00), so it survives; the evening gap after the ride also survives.
    expect(windows).toEqual([
      { carId: "car-1", start: at("09:00"), end: at("09:30") },
      { carId: "car-1", start: at("20:30"), end: DAY_END },
    ]);

    const droppedEntirely = computeCarFreeWindows({
      carId: "car-1",
      rides: [{ startsAt: "2026-09-08T06:00:00+03:00", endsAt: "2026-09-08T20:00:00+03:00" }],
      turnaroundMinutes: TURNAROUND_MIN,
      rangeStart: DAY_START,
      rangeEnd: DAY_END,
      now: at("09:00"),
    });
    // Morning gap 05:00-06:00 is entirely before "now" (09:00) -> dropped; only the evening
    // gap after the buffer survives.
    expect(droppedEntirely).toEqual([{ carId: "car-1", start: at("20:30"), end: DAY_END }]);
  });
});

describe("isSlotFree", () => {
  const windows = computeCarFreeWindows({
    carId: "car-1",
    rides: [{ startsAt: "2026-09-08T08:00:00+03:00", endsAt: "2026-09-08T10:00:00+03:00" }],
    turnaroundMinutes: TURNAROUND_MIN,
    rangeStart: DAY_START,
    rangeEnd: DAY_END,
    now: DAY_START - 60_000,
  });

  it("is true for a candidate slot fully inside a free window", () => {
    expect(isSlotFree(windows, "car-1", at("11:00"), at("13:00"))).toBe(true);
  });

  it("is false for a slot overlapping the buffer before the next free window", () => {
    expect(isSlotFree(windows, "car-1", at("10:00"), at("12:00"))).toBe(false);
  });

  it("is false for an unknown car", () => {
    expect(isSlotFree(windows, "car-2", at("11:00"), at("13:00"))).toBe(false);
  });
});

describe("nextFreeWindowForCar / firstCarFreeNow", () => {
  const carWindows = [
    { carId: "car-1", start: at("10:30"), end: at("12:00") },
    { carId: "car-2", start: at("05:00"), end: at("09:00") },
  ];

  it("finds the soonest window at or after a given instant", () => {
    expect(nextFreeWindowForCar(carWindows, "car-1", at("08:00"))).toEqual(carWindows[0]);
    expect(nextFreeWindowForCar(carWindows, "car-1", at("13:00"))).toBeNull();
  });

  it("finds the first car (in caller order) free exactly now", () => {
    expect(firstCarFreeNow(carWindows, at("05:00"))).toEqual(carWindows[1]);
    expect(firstCarFreeNow(carWindows, at("10:30"))).toEqual(carWindows[0]);
    expect(firstCarFreeNow(carWindows, at("10:31"))).toBeNull();
  });
});
