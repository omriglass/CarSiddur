import { describe, expect, it } from "vitest";

import {
  isDropTargetValid,
  isUnmetDropValid,
  seatsFit,
  type BoardDropContext,
} from "./dropValidity";
import type { UnmetListItem } from "./components/UnmetList";
import type { BoardRide, MaintenanceBlockRow, WeekRequestRow } from "../api";
import type { Car } from "@/features/fleet/api";

function ride(fields: Partial<BoardRide> & { id: string; car_id: string }): BoardRide {
  return { needs_driver: false, served: [], starts_at: null, ends_at: null, driver_id: null, ...fields } as unknown as BoardRide;
}

function car(id: string, status: Car["status"] = "active"): Car {
  return { id, status } as unknown as Car;
}

function request(fields: Partial<WeekRequestRow> & { id: string }): WeekRequestRow {
  return {
    trip_shape: "one_way_to", depart_at: null, return_at: null, adults: 1, child_seats: 0, boosters: 0,
    destination_travel_minutes: 30, flex_depart_early: "00:00:00", flex_depart_late: "00:00:00",
    flex_return_early: "00:00:00", flex_return_late: "00:00:00", status: "submitted",
    ...fields,
  } as unknown as WeekRequestRow;
}

function baseContext(overrides: Partial<BoardDropContext> = {}): BoardDropContext {
  return {
    rides: [],
    requests: [],
    cars: [car("car1")],
    maintenanceBlocks: [],
    seatConfigsByCarId: new Map(),
    unmetItems: [],
    selectedDay: "2026-09-13",
    chauffeurDwellMinutes: 10,
    ...overrides,
  };
}

describe("seatsFit", () => {
  it("does not block when the car has no seat configuration on record", () => {
    expect(seatsFit(baseContext(), "car1", { adults: 5, childSeats: 2, boosters: 2 })).toBe(true);
  });

  it("rejects a need that exceeds every configured seat set", () => {
    const ctx = baseContext({ seatConfigsByCarId: new Map([["car1", [{ adults: 4, child_seats: 1, boosters: 1 }]]]) });
    expect(seatsFit(ctx, "car1", { adults: 5, childSeats: 0, boosters: 0 })).toBe(false);
  });

  it("accepts when at least one configuration fits", () => {
    const ctx = baseContext({
      seatConfigsByCarId: new Map([["car1", [{ adults: 2, child_seats: 0, boosters: 0 }, { adults: 6, child_seats: 2, boosters: 2 }]]]),
    });
    expect(seatsFit(ctx, "car1", { adults: 5, childSeats: 1, boosters: 1 })).toBe(true);
  });
});

describe("isDropTargetValid", () => {
  it("rejects an unmet request card dropped on a phantom lane", () => {
    const ctx = baseContext();
    expect(isDropTargetValid(ctx, "request:r1", "phantom:0", 480, 510)).toBe(false);
  });

  it("rejects a ride placement whose target seats are too small", () => {
    const host = ride({ id: "host1", car_id: "car1", driver_id: "driver1", needs_driver: false,
      starts_at: "2026-09-13T06:00:00.000Z", ends_at: "2026-09-13T07:00:00.000Z", served: [] });
    const guestRequest = request({ id: "guest-req", adults: 4, trip_shape: "one_way_to", depart_at: "2026-09-13T06:20:00.000Z", destination_travel_minutes: 30 });
    const source = ride({ id: "guest1", car_id: "phantom:0", needs_driver: true, driver_id: null,
      starts_at: "2026-09-13T06:15:00.000Z", ends_at: "2026-09-13T06:45:00.000Z",
      served: [{ request_id: "guest-req", role: "driver", leg: "both", car_mode: "chauffeur", adults: 4, child_seats: 0, boosters: 0, luggage: false }] });
    const ctx = baseContext({
      rides: [host, source],
      requests: [guestRequest],
      seatConfigsByCarId: new Map([["car1", [{ adults: 2, child_seats: 0, boosters: 0 }]]]),
    });
    expect(isDropTargetValid(ctx, "guest1", "car1", 375, 405, "host1")).toBe(false);
  });

  it("accepts a normal ride move onto a free, available car", () => {
    const moved = ride({ id: "moved1", car_id: "car2", driver_id: "driver1", needs_driver: false,
      starts_at: "2026-09-13T06:00:00.000Z", ends_at: "2026-09-13T07:00:00.000Z", served: [] });
    const ctx = baseContext({ rides: [moved] });
    expect(isDropTargetValid(ctx, "moved1", "car1", 400, 460)).toBe(true);
  });
});

describe("isUnmetDropValid", () => {
  function unmetItem(req: WeekRequestRow): UnmetListItem {
    return { request: req, destinationName: "—" };
  }

  it("rejects placing an unmet request onto a car with a maintenance block covering the window", () => {
    // depart_at 08:00Z = 11:00 Asia/Jerusalem (UTC+3 in September) = minute 660 of the day;
    // the standalone chauffeur window (travel 30min out + 30min back + 10min dwell, snapped to
    // 15 minutes) is minute 660-735, i.e. 08:00Z-09:15Z — the maintenance block sits inside it.
    const req = request({ id: "r1", trip_shape: "one_way_to", depart_at: "2026-09-13T08:00:00.000Z", destination_travel_minutes: 30 });
    const block: MaintenanceBlockRow = { car_id: "car1", starts_at: "2026-09-13T08:30:00.000Z", ends_at: "2026-09-13T08:45:00.000Z" } as unknown as MaintenanceBlockRow;
    const ctx = baseContext({ maintenanceBlocks: [block] });
    expect(isUnmetDropValid(ctx, unmetItem(req), "car1", 660)).toBe(false);
  });

  it("rejects a merge whose expanded window overlaps another ride on the same car", () => {
    const host = ride({ id: "host1", car_id: "car1", driver_id: "driver1", needs_driver: false,
      starts_at: "2026-09-13T08:00:00.000Z", ends_at: "2026-09-13T09:00:00.000Z", served: [] });
    const other = ride({ id: "other1", car_id: "car1", driver_id: "driver2", needs_driver: false,
      starts_at: "2026-09-13T08:30:00.000Z", ends_at: "2026-09-13T09:30:00.000Z", served: [] });
    const req = request({ id: "r1", trip_shape: "one_way_to", depart_at: "2026-09-13T08:15:00.000Z", destination_travel_minutes: 30 });
    const ctx = baseContext({ rides: [host, other] });
    expect(isUnmetDropValid(ctx, unmetItem(req), "car1", 495, "host1")).toBe(false);
  });

  it("accepts a valid merge placement with no overlap and seats to spare", () => {
    const host = ride({ id: "host1", car_id: "car1", driver_id: "driver1", needs_driver: false,
      starts_at: "2026-09-13T08:00:00.000Z", ends_at: "2026-09-13T09:00:00.000Z", served: [] });
    const req = request({ id: "r1", trip_shape: "one_way_to", depart_at: "2026-09-13T08:15:00.000Z", destination_travel_minutes: 30 });
    const ctx = baseContext({ rides: [host] });
    expect(isUnmetDropValid(ctx, unmetItem(req), "car1", 495, "host1")).toBe(true);
  });
});
