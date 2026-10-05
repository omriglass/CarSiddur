import { describe, expect, it } from "vitest";

import { connectedPairRideIds, unmetItemId, unmetItemKey, unmetRequestViews, viewsOnDay } from "./unmetLegs";

import type { BoardRide, WeekRequestRow } from "../api";

const request = (over: Partial<WeekRequestRow> = {}) => ({
  id: "r1", status: "waitlisted", trip_shape: "round_trip", trip_type: "drop_off",
  depart_at: "2026-10-11T06:00:00.000Z", return_at: "2026-10-11T12:00:00.000Z", ...over,
}) as unknown as WeekRequestRow;
const ride = (leg: string, over: Partial<BoardRide> = {}) => ({ id: "ride", status: "confirmed", served: [{ request_id: "r1", leg, role: "passenger", car_mode: "chauffeur", adults: 1, child_seats: 0, boosters: 0, luggage: false }], ...over }) as unknown as BoardRide;
const none = { awaitingDriverRequestIds: new Set<string>(), draftPlacedRequestIds: new Set<string>() };

describe("unmetRequestViews", () => {
  it("a drop-off with pickup shows two one-leg cards", () => {
    const views = unmetRequestViews([request()], [], none);
    expect(views.map(unmetItemId)).toEqual(["request:r1", "request:r1:return"]);
    expect(views[0]!.request.trip_shape).toBe("one_way_to");
    expect(views[1]!.request.trip_shape).toBe("one_way_from");
    expect(views[1]!.request.depart_at).toBeNull();
    expect(unmetItemKey(views[1]!)).toBe("r1:return");
  });

  it("a placed out leg (awaiting a driver, request off the unmet list) leaves only the pickup card", () => {
    const views = unmetRequestViews([request({ status: "waitlisted" })], [ride("out")], { ...none, awaitingDriverRequestIds: new Set(["r1"]) });
    expect(views.map((v) => v.leg)).toEqual(["return"]);
  });

  it("both legs covered -> nothing; an assigned request with a missing leg still shows it", () => {
    expect(unmetRequestViews([request({ status: "assigned" })], [ride("both")], none)).toEqual([]);
    expect(unmetRequestViews([request({ status: "assigned" })], [ride("return")], none).map((v) => v.leg)).toEqual(["out"]);
  });

  it("other trip types keep one whole card and obey the awaiting-driver exclusion", () => {
    const oneWay = request({ trip_type: "one_way", trip_shape: "one_way_to" });
    expect(unmetRequestViews([oneWay], [], none)).toEqual([{ request: oneWay }]);
    expect(unmetRequestViews([oneWay], [], { ...none, awaitingDriverRequestIds: new Set(["r1"]) })).toEqual([]);
    expect(unmetRequestViews([request({ trip_type: "round_trip" })], [], none)).toHaveLength(1);
  });

  it("skips draft-placed requests and keeps a denied drop-off as one card", () => {
    expect(unmetRequestViews([request()], [], { ...none, draftPlacedRequestIds: new Set(["r1"]) })).toEqual([]);
    expect(unmetRequestViews([request({ status: "denied" })], [], none)).toHaveLength(1);
  });

  it("viewsOnDay anchors the pickup card on its return day", () => {
    const views = unmetRequestViews([request()], [], none);
    expect(viewsOnDay(views, "2026-10-11", (iso) => iso.slice(0, 10))).toHaveLength(2);
    expect(viewsOnDay(views, "2026-10-12", (iso) => iso.slice(0, 10))).toHaveLength(0);
  });
});

describe("connectedPairRideIds (REQ §13.95 H2)", () => {
  const driven = (id: string, leg: string, car = "c1") => ride(leg, { id, car_id: car, driver_id: "u1", needs_driver: false } as Partial<BoardRide>);
  it("links the out and return rides of one request on one car, both driven", () => {
    expect([...connectedPairRideIds([driven("a", "out"), driven("b", "return")])].sort()).toEqual(["a", "b"]);
  });
  it("ignores driverless rides, other cars and same-leg pairs", () => {
    expect(connectedPairRideIds([driven("a", "out"), ride("return", { id: "b", car_id: "c1", needs_driver: true } as Partial<BoardRide>)]).size).toBe(0);
    expect(connectedPairRideIds([driven("a", "out"), driven("b", "return", "c2")]).size).toBe(0);
    expect(connectedPairRideIds([driven("a", "out"), driven("b", "out")]).size).toBe(0);
  });
});
