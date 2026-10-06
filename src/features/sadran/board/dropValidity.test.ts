import { describe, expect, it } from "vitest";

import {
  connectsOtherLeg,
  isDropTargetValid,
  isUnmetDropValid,
  originMismatch,
  seatsFit,
  strandsNextRide,
  unavailable,
  unmetCandidateWindow,
  unmetMergeHost,
  unmetPlacement,
  unmetRequestPassengers,
  unmetShiftPayload,
  type BoardDropContext,
} from "./dropValidity";
import { slotToIso } from "./geometry";
import { mergedHostWindow } from "./dropValidity";
import { mergeInvalidReason } from "./mergeProposal";
import { makeHop } from "@/lib/rideRoute";
import type { UnmetListItem } from "./components/UnmetList";
import type { BoardRide, MaintenanceBlockRow, WeekRequestRow } from "../api";
import type { Car } from "@/features/fleet/api";

function ride(fields: Partial<BoardRide> & { id: string; car_id: string }): BoardRide {
  return { needs_driver: false, served: [{ request_id: "r-default", role: "driver", leg: "both" }], starts_at: null, ends_at: null, driver_id: null, ...fields } as unknown as BoardRide;
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

describe("unavailable (maintenance/active only — REQUIREMENTS §13.93)", () => {
  const WEEK_START_MS = Date.parse("2026-09-13T00:00:00.000Z");

  it("never blocks on an away window any more — a manual ride move is always allowed location-wise", () => {
    const ctx = baseContext({
      awayByCarId: new Map([["car1", [{ locationId: "away-dest", window: { start: 32, end: 48 } }]]]),
      weekStartMs: WEEK_START_MS,
    });
    // Slots 32..48 = away; a manual ride move into it is still allowed (chain-break warning
    // shown afterwards instead) — only `isUnmetDropValid` gates a *new* request card on origin.
    expect(unavailable(ctx, "car1", slotToIso(36, WEEK_START_MS), slotToIso(40, WEEK_START_MS))).toBe(false);
  });

  it("is a no-op when weekStartMs/awayByCarId are omitted (callers that never built a conflict scan)", () => {
    const ctx = baseContext();
    expect(unavailable(ctx, "car1", "2026-09-13T06:00:00.000Z", "2026-09-13T07:00:00.000Z")).toBe(false);
  });
});

describe("originMismatch (REQUIREMENTS §13.93)", () => {
  const WEEK_START_MS = Date.parse("2026-09-13T00:00:00.000Z");

  it("rejects a request whose origin differs from where the car actually is (in an away window)", () => {
    const ctx = baseContext({
      awayByCarId: new Map([["car1", [{ locationId: "harish", window: { start: 32, end: 48 } }]]]),
      weekStartMs: WEEK_START_MS,
      homeDestinationId: "home",
    });
    expect(originMismatch(ctx, "car1", "home", slotToIso(36, WEEK_START_MS))).toBe(true);
    expect(originMismatch(ctx, "car1", "harish", slotToIso(36, WEEK_START_MS))).toBe(false);
  });

  it("matches the car's own base outside any away window", () => {
    const ctx = baseContext({
      carBaseLocationId: new Map([["car1", "binyamina"]]),
      weekStartMs: WEEK_START_MS,
      homeDestinationId: "home",
    });
    expect(originMismatch(ctx, "car1", "binyamina", slotToIso(10, WEEK_START_MS))).toBe(false);
    expect(originMismatch(ctx, "car1", "home", slotToIso(10, WEEK_START_MS))).toBe(true);
  });

  it("never blocks when the context has no location data loaded yet", () => {
    const ctx = baseContext();
    expect(originMismatch(ctx, "car1", "home", "2026-09-13T06:00:00.000Z")).toBe(false);
  });
});

describe("strandsNextRide - reservations (REQ §13.96)", () => {
  it("a following reservation labelled elsewhere never strands the ride", () => {
    const ctx = { rides: [ride({ id: "res", car_id: "car1", starts_at: "2026-09-13T11:00:00.000Z", origin_id: "haifa", served: [] } as unknown as Partial<BoardRide> & { id: string; car_id: string })] } as unknown as BoardDropContext;
    expect(strandsNextRide(ctx, "car1", "home", "2026-09-13T09:00:00.000Z")).toBe(false);
  });
});

describe("strandsNextRide (REQUIREMENTS §13.93)", () => {
  it("rejects a one-way drop that would leave the car somewhere its next ride doesn't start", () => {
    const ctx = baseContext({
      rides: [ride({ id: "next1", car_id: "car1", origin_id: "home", starts_at: "2026-09-13T10:00:00.000Z", ends_at: "2026-09-13T11:00:00.000Z" })],
    });
    expect(strandsNextRide(ctx, "car1", "harish", "2026-09-13T09:00:00.000Z")).toBe(true);
    expect(strandsNextRide(ctx, "car1", "home", "2026-09-13T09:00:00.000Z")).toBe(false);
  });

  it("never blocks when there is no later ride on that car", () => {
    const ctx = baseContext();
    expect(strandsNextRide(ctx, "car1", "harish", "2026-09-13T09:00:00.000Z")).toBe(false);
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
      starts_at: "2026-09-13T08:00:00.000Z", ends_at: "2026-09-13T09:00:00.000Z" });
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

  it("rejects a no-host drop whose standalone window overlaps an existing ride on the target car", () => {
    // No `hostRideId` -> no merge host; the target car already has a ride sitting inside the
    // standalone chauffeur window this request would need.
    const existing = ride({ id: "existing1", car_id: "car1", driver_id: "driver1", needs_driver: false,
      starts_at: "2026-09-13T08:00:00.000Z", ends_at: "2026-09-13T09:00:00.000Z", served: [] });
    const req = request({ id: "r1", trip_shape: "one_way_to", depart_at: "2026-09-13T08:00:00.000Z", destination_travel_minutes: 30 });
    const ctx = baseContext({ rides: [existing] });
    expect(isUnmetDropValid(ctx, unmetItem(req), "car1", 660)).toBe(false);
  });

  it("accepts a no-host drop onto a car with a free window (no overlap)", () => {
    const existing = ride({ id: "existing1", car_id: "car1", driver_id: "driver1", needs_driver: false,
      starts_at: "2026-09-13T06:00:00.000Z", ends_at: "2026-09-13T07:00:00.000Z", served: [] });
    const req = request({ id: "r1", trip_shape: "one_way_to", depart_at: "2026-09-13T08:00:00.000Z", destination_travel_minutes: 30 });
    const ctx = baseContext({ rides: [existing] });
    expect(isUnmetDropValid(ctx, unmetItem(req), "car1", 660)).toBe(true);
  });
});

describe("unmet placement by trip type (REQUIREMENTS §13.93)", () => {
  const item = (req: WeekRequestRow): UnmetListItem => ({ request: req, destinationName: "—" });
  const ctx = baseContext({ homeDestinationId: "home", carBaseLocationId: new Map([["car1", "home"]]), weekStartMs: Date.parse("2026-09-13T00:00:00.000Z") });
  const departAt = "2026-09-13T08:00:00.000Z";
  const base = { id: "r1", depart_at: departAt, origin_id: "kfar", destination_id: "haifa" };

  it("round trip: origin = destination = the request's origin, requester drives, keep", () => {
    const req = request({ ...base, trip_type: "round_trip", trip_shape: "round_trip", return_at: "2026-09-13T12:00:00.000Z" });
    expect(unmetPlacement(ctx, req, "car1", departAt)).toEqual({ originId: "kfar", destinationId: "kfar", driverIsRequester: true, served: { role: "driver", leg: "both", car_mode: "keep" } });
  });

  it("round trip without its own origin falls back to the department home", () => {
    const req = request({ id: "r1", depart_at: departAt, origin_id: null, trip_type: "round_trip", trip_shape: "round_trip" });
    expect(unmetPlacement(ctx, req, "car1", departAt)?.originId).toBe("home");
  });

  it("one way: origin -> destination, requester drives as the driver on a relay leg, window = departure + route minutes", () => {
    const req = request({ ...base, trip_type: "one_way", trip_shape: "one_way_to", destination_travel_minutes: 30 });
    expect(unmetPlacement(ctx, req, "car1", departAt)).toEqual({ originId: "kfar", destinationId: "haifa", driverIsRequester: true, served: { role: "driver", leg: "out", car_mode: "relay" } });
    // Not the chauffeur window (2 x 30 + dwell): the requester drives out and stays there.
    expect(unmetCandidateWindow(ctx, item(req), 660, true)).toEqual({ startsAt: "2026-09-13T08:00:00.000Z", endsAt: "2026-09-13T08:30:00.000Z" });
    expect(unmetRequestPassengers(req)).toEqual({ adults: 1, childSeats: 0, boosters: 0 });
  });

  it("one way without a list destination cannot be placed", () => {
    const req = request({ ...base, destination_id: null, trip_type: "one_way", trip_shape: "one_way_to" });
    expect(unmetPlacement(ctx, req, "car1", departAt)).toBeNull();
  });

  it("drop-off: a chauffeur ride whose places are where the car is, not the department home", () => {
    const req = request({ ...base, trip_type: "drop_off", trip_shape: "one_way_to" });
    const away = baseContext({ homeDestinationId: "home", carBaseLocationId: new Map([["car1", "home"]]), weekStartMs: Date.parse("2026-09-13T00:00:00.000Z"),
      awayByCarId: new Map([["car1", [{ locationId: "kfar", window: { start: 0, end: 96 } }]]]) });
    expect(unmetPlacement(away, req, "car1", departAt)).toEqual({ originId: "kfar", destinationId: "kfar", driverIsRequester: false, served: { role: "passenger", leg: "out", car_mode: "chauffeur" } });
    expect(unmetCandidateWindow(ctx, item(req), 660, true)).toEqual({ startsAt: "2026-09-13T08:00:00.000Z", endsAt: "2026-09-13T09:15:00.000Z" });
    expect(unmetRequestPassengers(req).adults).toBe(2);
  });

  it("drop-off with pickup (round-trip shape) places only the out leg as a chauffeur leg", () => {
    const req = request({ ...base, trip_type: "drop_off", trip_shape: "round_trip", return_at: "2026-09-13T12:00:00.000Z" });
    expect(unmetPlacement(ctx, req, "car1", departAt)?.served).toEqual({ role: "passenger", leg: "out", car_mode: "chauffeur" });
    expect(unmetCandidateWindow(ctx, item(req), 660, true)).toEqual({ startsAt: "2026-09-13T08:00:00.000Z", endsAt: "2026-09-13T09:15:00.000Z" });
  });

  it("a drop on a ride is a merge attempt for every trip type (R2B7), but never onto a ride serving the same request", () => {
    const host = ride({ id: "host1", car_id: "car1", driver_id: "d", needs_driver: false, starts_at: departAt, ends_at: "2026-09-13T09:00:00.000Z" });
    const withHost = baseContext({ rides: [host] });
    expect(unmetMergeHost(withHost, item(request({ ...base, trip_type: "round_trip", trip_shape: "round_trip" })), "car1", 0, "host1")?.id).toBe("host1");
    expect(unmetMergeHost(withHost, item(request({ ...base, trip_type: "drop_off", trip_shape: "round_trip" })), "car1", 0, "host1")?.id).toBe("host1");
    expect(unmetMergeHost(withHost, item(request({ ...base, trip_type: "one_way", trip_shape: "one_way_to" })), "car1", 0, "host1")?.id).toBe("host1");
  });

  it("the beyond-flex shift payload carries car and times only, never places", () => {
    const window = { startsAt: departAt, endsAt: "2026-09-13T12:00:00.000Z" };
    const round = request({ ...base, trip_type: "round_trip", trip_shape: "round_trip", return_at: window.endsAt });
    expect(unmetShiftPayload(round, "car1", window, unmetPlacement(ctx, round, "car1", departAt)!)).toEqual({ car_id: "car1", depart_at: departAt, return_at: window.endsAt });
    const oneWay = request({ ...base, trip_type: "one_way", trip_shape: "one_way_to" });
    expect(unmetShiftPayload(oneWay, "car1", window, unmetPlacement(ctx, oneWay, "car1", departAt)!)).toEqual({ car_id: "car1", depart_at: departAt });
    const drop = request({ ...base, trip_type: "drop_off", trip_shape: "one_way_to" });
    expect(unmetShiftPayload(drop, "car1", window, unmetPlacement(ctx, drop, "car1", departAt)!)).toEqual({ depart_at: departAt });
  });
});

describe("merge validity and connected legs (REQ §13.95)", () => {
  const route = {
    hop: makeHop([
      { fromId: "H", toId: "D", travelMinutes: 60 },
      { fromId: "H", toId: "T", travelMinutes: 20 },
      { fromId: "T", toId: "D", travelMinutes: 45 },
      { fromId: "H", toId: "AF", travelMinutes: 45 },
      { fromId: "D", toId: "AF", travelMinutes: 40 },
    ]),
    stopMinutes: 5, homeId: "H", detourLimitMinutes: 20,
  };
  const host = ride({ id: "host1", car_id: "car1", driver_id: "driver1", needs_driver: false, origin_id: "H", destination_id: "D",
    starts_at: "2026-09-13T04:15:00.000Z", ends_at: "2026-09-13T07:00:00.000Z", served: [] } as Partial<BoardRide> & { id: string; car_id: string });
  const guest = (over: Partial<WeekRequestRow>) => request({ id: "g1", trip_type: "one_way", trip_shape: "one_way_to", depart_at: "2026-09-13T04:30:00.000Z", ...over } as Partial<WeekRequestRow> & { id: string });

  it("a bus-station detour moves the merged window's start earlier", () => {
    const ctx = baseContext({ rides: [host], route });
    const window = mergedHostWindow(ctx, host, guest({ origin_id: "T", destination_id: "D" }), "out");
    expect(window).toEqual({ startsAt: "2026-09-13T04:00:00.000Z", endsAt: "2026-09-13T07:00:00.000Z" });
  });

  it("a guest boarding at the base's final destination is not a valid merge target", () => {
    const g = guest({ origin_id: "D", destination_id: "AF" });
    expect(mergeInvalidReason(host, g, "out", route)).toBe("boards_at_end");
    const ctx = baseContext({ rides: [host], route });
    expect(isUnmetDropValid(ctx, { request: g, destinationName: "—" }, "car1", 495, "host1")).toBe(false);
  });

  it("a detour over the department limit is not a valid merge target", () => {
    const g = guest({ origin_id: "AF", destination_id: "D" });
    expect(mergeInvalidReason(host, g, "out", route)).toBe("detour_too_long");
  });

  it("recognises the car that already carries a הקפצה's other leg", () => {
    const first = ride({ id: "r-out", car_id: "car1", driver_id: "u1", status: "confirmed",
      served: [{ request_id: "g1", role: "driver", leg: "out", car_mode: "chauffeur", adults: 1, child_seats: 0, boosters: 0, luggage: false }] } as unknown as Partial<BoardRide> & { id: string; car_id: string });
    const item = { request: guest({ trip_type: "drop_off", trip_shape: "one_way_from" }), leg: "return" as const, destinationName: "—" };
    expect(connectsOtherLeg({ rides: [first] }, item, "car1")).toBe(true);
    expect(connectsOtherLeg({ rides: [first] }, item, "car2")).toBe(false);
    expect(connectsOtherLeg({ rides: [] }, item, "car1")).toBe(false);
  });
});

import { legStartPlaceId } from "./dropValidity";
import { requestWithinFlex } from "./phantomLanes";

describe("legStartPlaceId (R2B8)", () => {
  const base = { origin_id: "O", destination_id: "D" };
  it("uses the leg's real start place", () => {
    expect(legStartPlaceId({ ...base, trip_shape: "round_trip", trip_type: "round_trip" }, "H")).toBe("O");
    expect(legStartPlaceId({ ...base, trip_shape: "one_way_from", trip_type: "one_way" }, "H")).toBe("D");
    expect(legStartPlaceId({ origin_id: null, destination_id: "D", trip_shape: "round_trip", trip_type: "round_trip" }, "H")).toBe("H");
  });
  it("does not constrain a chauffeur (הקפצה) leg", () => {
    expect(legStartPlaceId({ ...base, trip_shape: "one_way_from", trip_type: "drop_off" }, "H")).toBeNull();
    expect(legStartPlaceId({ ...base, trip_shape: "one_way_to", trip_type: "drop_off" }, "H")).toBeNull();
  });
});

describe("requestWithinFlex chauffeur pickup (R2B9)", () => {
  it("judges a pickup ride's end against the return time and flexibility", () => {
    const req = { trip_shape: "round_trip", trip_type: "drop_off", depart_at: "2026-10-12T05:00:00.000Z", return_at: "2026-10-12T10:00:00.000Z", flex_return_early: "00:00:00", flex_return_late: "00:30:00", flex_depart_early: "00:00:00", flex_depart_late: "00:00:00" } as never;
    // ride 09:30-10:00 ends at the return time: within flexibility
    expect(requestWithinFlex(req, "2026-10-12T09:30:00.000Z", "2026-10-12T10:00:00.000Z", "return", true)).toBe(true);
    expect(requestWithinFlex(req, "2026-10-12T09:30:00.000Z", "2026-10-12T11:00:00.000Z", "return", true)).toBe(false);
  });
});
