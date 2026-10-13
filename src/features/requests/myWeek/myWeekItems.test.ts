import { describe, expect, it } from "vitest";

import type { BoardRide } from "@/features/siddur/api";

import type { MyRequestRow, TemplateSuggestion } from "../api";
import { weekDayKeys } from "./dayColumns";
import { isMyBoardRide, requestBlockKind, requestBlocks, rideBlocks, rideWithCarLabel, suggestionBlocks, visibleStartMinutes, withLanes } from "./myWeekItems";

const week = weekDayKeys("2026-10-11");
const NOW = Date.parse("2026-10-11T06:00:00Z");

function request(over: Partial<MyRequestRow>): MyRequestRow {
  return {
    id: "r1", departmentId: "d", weekStart: "2026-10-11", status: "submitted", statusReason: null,
    departAt: "2026-10-12T05:00:00Z", returnAt: "2026-10-12T09:00:00Z", tripType: "round_trip", destination: "חיפה",
    originId: null, originText: null, originName: null, stops: [], legs: [], ride: null, pendingProposal: null,
    seriesId: null, seriesIndex: null, seriesCount: null,
    ...over,
  } as unknown as MyRequestRow;
}

function ride(over: Partial<BoardRide>): BoardRide {
  return {
    id: "ride1", status: "confirmed", car_id: "car1", starts_at: "2026-10-13T05:00:00Z", ends_at: "2026-10-13T08:00:00Z",
    driver_id: null, served: [], passengers: [], needs_driver: false, notes: null, destination_name: "חיפה", origin_name: "נבו",
    series_index: null, series_count: null,
    ...over,
  } as unknown as BoardRide;
}

describe("requestBlockKind", () => {
  it("maps filed and waiting requests", () => {
    expect(requestBlockKind(request({ status: "submitted" }), NOW)).toBe("request");
    expect(requestBlockKind(request({ status: "draft" }), NOW)).toBe("request");
    expect(requestBlockKind(request({ status: "waitlisted" }), NOW)).toBe("waiting");
    expect(requestBlockKind(request({ status: "external" }), NOW)).toBe("waiting");
  });

  it("hides cancelled, withdrawn and denied", () => {
    for (const status of ["cancelled", "withdrawn", "denied"] as const) {
      expect(requestBlockKind(request({ status }), NOW)).toBeNull();
    }
  });

  it("leaves a placed request to its ride", () => {
    expect(requestBlockKind(request({ status: "assigned" }), NOW)).toBeNull();
    expect(requestBlockKind(request({ status: "merged" }), NOW)).toBeNull();
  });

  it("shows only a proposal still awaiting my answer as a proposal", () => {
    const pending = { id: "p", type: "shift", reasonHe: "", expiresAt: null } as MyRequestRow["pendingProposal"];
    expect(requestBlockKind(request({ status: "proposed", pendingProposal: pending }), NOW)).toBe("proposal");
    const expired = { id: "p", type: "shift", reasonHe: "", expiresAt: "2026-10-10T00:00:00Z" } as MyRequestRow["pendingProposal"];
    expect(requestBlockKind(request({ status: "proposed", pendingProposal: expired }), NOW)).toBe("request");
    expect(requestBlockKind(request({ status: "proposed", pendingProposal: null }), NOW)).toBe("request");
  });
});

describe("requestBlocks", () => {
  it("draws a request from its out time to its return time on its day", () => {
    const [entry] = requestBlocks([request({})], week, null, NOW);
    expect(entry?.block).toMatchObject({ id: "request:r1", carId: "2026-10-12", startMinutes: 480, endMinutes: 720, kind: "request" });
    expect(entry?.target).toMatchObject({ type: "request" });
  });

  it("drops a request on a day already gone, keeping today onward (owner 2026-10-13)", () => {
    const tuesdayMorning = Date.parse("2026-10-13T06:00:00Z");
    expect(requestBlocks([request({})], week, null, tuesdayMorning)).toEqual([]);
    const today = requestBlocks([request({ departAt: "2026-10-13T08:00:00+03:00", returnAt: "2026-10-13T12:00:00+03:00" })], week, null, tuesdayMorning);
    expect(today).toHaveLength(1);
  });

  it("gives a one-way request a one-hour block", () => {
    const [entry] = requestBlocks([request({ returnAt: null })], week, null, NOW);
    expect(entry?.block).toMatchObject({ startMinutes: 480, endMinutes: 540 });
  });

  it("targets the proposal for an awaiting proposal and skips hidden rows", () => {
    const pending = { id: "p", type: "shift", reasonHe: "", expiresAt: null } as MyRequestRow["pendingProposal"];
    const blocks = requestBlocks([
      request({ id: "a", status: "proposed", pendingProposal: pending }),
      request({ id: "b", status: "withdrawn" }),
    ], week, null, NOW);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.block.kind).toBe("proposal");
    expect(blocks[0]?.target.type).toBe("proposal");
  });

  it("skips a request with no time at all", () => {
    expect(requestBlocks([request({ departAt: null, returnAt: null })], week, null, NOW)).toEqual([]);
  });
});

describe("suggestionBlocks", () => {
  it("draws a dotted suggestion on its day", () => {
    const suggestion = { templateId: "t1", weekStart: "2026-10-11", destinationName: "חיפה", destinationText: null, originId: null, originText: null, originName: null, stops: [], departAt: "2026-10-14T05:00:00Z", returnAt: "2026-10-14T10:00:00Z" } as unknown as TemplateSuggestion;
    const [entry] = suggestionBlocks([suggestion], week, null);
    expect(entry?.block).toMatchObject({ id: "suggestion:t1:2026-10-11", carId: "2026-10-14", kind: "suggestion", startMinutes: 480, endMinutes: 780 });
    expect(entry?.target).toEqual({ type: "suggestion", suggestion });
  });
});

describe("rideBlocks", () => {
  it("labels each ride with its car and skips cancelled and unpublished rides", () => {
    const blocks = rideBlocks(
      [ride({}), ride({ id: "x", status: "cancelled" }), ride({ id: "y", status: "draft" })],
      week,
      () => "route",
    );
    expect(blocks.map((b) => b.block.id)).toEqual(["ride:ride1"]);
    // Owner 2026-10-11: a served ride carries its public notes, as on the siddur; a reservation's notes are its label.
    const served = [{ request_id: "q1", role: "driver", requester: "דנה", adults: 1, child_seats: 0, boosters: 0, car_mode: "keep", leg: "both" }];
    const noted = rideBlocks([ride({ notes: "המפתח אצל דנה", served } as unknown as Partial<BoardRide>)], week, () => "route");
    expect(noted[0]?.block.description).toContain("המפתח אצל דנה");
    expect(rideBlocks([ride({ notes: "שמירת זמן" })], week, () => "route")[0]?.block.description ?? "").not.toContain("שמירת זמן");
    expect(blocks[0]?.block).toMatchObject({ carId: "2026-10-13", startMinutes: 480, endMinutes: 660, isMine: true });
  });

  it("includes the car name in the label", () => {
    expect(rideWithCarLabel("", "route")).toBe("route");
    expect(rideWithCarLabel("קורולה", "route")).toContain("קורולה");
  });
});

describe("isMyBoardRide", () => {
  it("recognises driver, passenger-by-request and named passenger", () => {
    const ids = new Set(["mine"]);
    expect(isMyBoardRide(ride({ driver_id: "me" }), "me", ids)).toBe(true);
    expect(isMyBoardRide(ride({ served: [{ request_id: "mine", role: "passenger" }] as unknown as BoardRide["served"] }), "me", ids)).toBe(true);
    expect(isMyBoardRide(ride({ passengers: [{ person_id: "me" }] as unknown as BoardRide["passengers"] }), "me", ids)).toBe(true);
    expect(isMyBoardRide(ride({ driver_id: "other" }), "me", ids)).toBe(false);
    expect(isMyBoardRide(ride({ driver_id: "me" }), undefined, ids)).toBe(false);
  });
});

describe("withLanes", () => {
  it("puts a ride and a request that overlap on one day side by side", () => {
    const rides = rideBlocks([ride({ starts_at: "2026-10-12T05:00:00Z", ends_at: "2026-10-12T08:00:00Z" })], week, () => "x");
    const requests = requestBlocks([request({})], week, null, NOW);
    const laned = withLanes([...rides, ...requests]);
    expect(laned.map((e) => e.block.laneCount)).toEqual([2, 2]);
    expect(new Set(laned.map((e) => e.block.lane))).toEqual(new Set([0, 1]));
  });
});

describe("visibleStartMinutes", () => {
  it("keeps the board start unless an item begins earlier", () => {
    const early = rideBlocks([ride({ starts_at: "2026-10-13T02:30:00Z" })], week, () => "x"); // 05:30
    expect(visibleStartMinutes(early, 360)).toBe(300);
    expect(visibleStartMinutes(rideBlocks([ride({})], week, () => "x"), 360)).toBe(360);
    expect(visibleStartMinutes([], 360)).toBe(360);
  });
});
