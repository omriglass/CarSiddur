import { describe, expect, it } from "vitest";

import { alternativeLegs, requestIdsWithOpenProposal, resolveDraftPlacement, resolveDraftPlacements } from "./draftOverlay";
import { makeHop } from "@/lib/rideRoute";
import type { BoardRide, ProposalRow, WeekRequestRow } from "../api";

const request = (over: Partial<WeekRequestRow> = {}) => ({
  id: "req1", trip_shape: "round_trip", depart_at: "2026-10-11T06:00:00.000Z", return_at: "2026-10-11T10:00:00.000Z",
  origin_id: null, destination_id: "dest", destination_travel_minutes: 30, ...over,
}) as unknown as WeekRequestRow;
const ride = (over: Partial<BoardRide> = {}) => ({
  id: "ride1", car_id: "carA", starts_at: "2026-10-11T06:00:00.000Z", ends_at: "2026-10-11T10:00:00.000Z",
  origin_id: "home", destination_id: "home", served: [{ request_id: "req1" }], ...over,
}) as unknown as BoardRide;
const proposal = (over: Partial<ProposalRow>) => ({
  id: "p1", type: "shift", status: "draft", request_id: "req1", ride_id: null, payload: {}, ...over,
}) as unknown as ProposalRow;

describe("resolveDraftPlacement", () => {
  it("shift: the unmet request lands on the payload car at the proposed times", () => {
    const placement = resolveDraftPlacement(proposal({ payload: { car_id: "carB", depart_at: "2026-10-11T08:00:00.000Z", return_at: "2026-10-11T12:00:00.000Z" } }), [request()], [], "home");
    expect(placement).toMatchObject({ type: "shift", carId: "carB", startsAt: "2026-10-11T08:00:00.000Z", endsAt: "2026-10-11T12:00:00.000Z", originId: "home", replacesRideId: null });
  });
  it("shift without a car stays on the ride's car and replaces that ride", () => {
    const placement = resolveDraftPlacement(proposal({ ride_id: "ride1", payload: { depart_at: "2026-10-11T07:00:00.000Z" } }), [request()], [ride()], "home");
    expect(placement).toMatchObject({ carId: "carA", startsAt: "2026-10-11T07:00:00.000Z", endsAt: "2026-10-11T10:00:00.000Z", replacesRideId: "ride1" });
  });
  it("shift with no car anywhere is not placed", () => {
    expect(resolveDraftPlacement(proposal({ payload: {} }), [request()], [], "home")).toBeNull();
  });
  it("one-way-from shifts move the return and keep the duration", () => {
    const req = request({ trip_shape: "one_way_from", depart_at: null, return_at: "2026-10-11T10:00:00.000Z" });
    const placement = resolveDraftPlacement(proposal({ payload: { car_id: "carB", return_at: "2026-10-11T11:00:00.000Z" } }), [req], [], "home");
    expect(placement?.endsAt).toBe("2026-10-11T11:00:00.000Z");
    expect(placement?.startsAt).toBe("2026-10-11T10:30:00.000Z");
  });
  it("R5B3/R5B11: a drop-off shift carrying only a return time is the pickup leg (inferred like the server)", () => {
    const req = request({ trip_type: "drop_off", depart_at: "2026-10-11T04:30:00.000Z", return_at: "2026-10-11T11:00:00.000Z" } as Partial<WeekRequestRow>);
    const placement = resolveDraftPlacement(proposal({ payload: { car_id: "carB", depart_at: null, return_at: "2026-10-11T11:00:00.000Z" } }), [req], [], "home");
    expect(placement).toMatchObject({ leg: "return", carId: "carB", endsAt: "2026-10-11T11:00:00.000Z" });
  });
  it("R4B4: a pickup-leg shift draws only that leg on its car and does not replace the out-leg ride", () => {
    const req = request({ trip_type: "drop_off", depart_at: "2026-10-11T04:30:00.000Z", return_at: "2026-10-11T11:00:00.000Z" } as Partial<WeekRequestRow>);
    const outRide = ride({ starts_at: "2026-10-11T04:30:00.000Z", ends_at: "2026-10-11T05:30:00.000Z" });
    const placement = resolveDraftPlacement(proposal({ payload: { car_id: "carB", return_at: "2026-10-11T11:00:00.000Z", leg: "return" } }), [req], [outRide], "home");
    expect(placement).toMatchObject({ carId: "carB", endsAt: "2026-10-11T11:00:00.000Z", replacesRideId: null });
    expect(Date.parse(placement!.startsAt)).toBeGreaterThan(Date.parse("2026-10-11T10:00:00.000Z"));
  });
  it("REQ 105 d: a fewer-days draft is drawn on the span's own day and car, not on the series head's day", () => {
    const head = request({ depart_at: "2026-10-12T05:00:00.000Z", return_at: "2026-10-12T20:59:00.000Z" });
    const placement = resolveDraftPlacement(proposal({ payload: { car_id: "carB", series_span: { depart_at: "2026-10-14T05:00:00.000Z", return_at: "2026-10-14T14:00:00.000Z" } } }), [head], [], "home");
    expect(placement).toMatchObject({ type: "shift", carId: "carB", startsAt: "2026-10-14T05:00:00.000Z", endsAt: "2026-10-14T14:00:00.000Z" });
  });
  it("merge: host car with the payload's combined window", () => {
    const placement = resolveDraftPlacement(proposal({ type: "merge", ride_id: "ride1", payload: { starts_at: "2026-10-11T05:00:00.000Z", ends_at: "2026-10-11T11:00:00.000Z" } }), [request()], [ride()]);
    expect(placement).toMatchObject({ type: "merge", carId: "carA", hostRideId: "ride1", startsAt: "2026-10-11T05:00:00.000Z" });
  });
  it("merge without a payload window leaves earlier by the added driving and keeps the end", () => {
    const hop = makeHop([{ fromId: "home", toId: "dest", travelMinutes: 60 }, { fromId: "home", toId: "stn", travelMinutes: 20 }, { fromId: "stn", toId: "dest", travelMinutes: 45 }]);
    const host = ride({ origin_id: "home", destination_id: "dest", route: [] as never, starts_at: "2026-10-11T06:00:00.000Z", ends_at: "2026-10-11T08:00:00.000Z" });
    const guest = request({ trip_shape: "one_way_to", origin_id: "stn", destination_id: "dest" });
    const placement = resolveDraftPlacement(proposal({ type: "merge", ride_id: "ride1", payload: { ride_id: "ride1", legs: [{ ride_id: "ride1", role: "passenger", leg: "out", car_mode: "passenger" }] } }), [guest], [host], "home", { hop, stopMinutes: 5 });
    expect(placement).toMatchObject({ type: "merge", carId: "carA", startsAt: "2026-10-11T05:45:00.000Z", endsAt: "2026-10-11T08:00:00.000Z" });
  });
  it("merge: the server's merge_preview window wins over the route twin (REQ item 108 M1)", () => {
    const hop = makeHop([{ fromId: "home", toId: "dest", travelMinutes: 60 }, { fromId: "home", toId: "stn", travelMinutes: 20 }, { fromId: "stn", toId: "dest", travelMinutes: 45 }]);
    const host = ride({ origin_id: "home", destination_id: "dest", route: [] as never, starts_at: "2026-10-11T06:00:00.000Z", ends_at: "2026-10-11T08:00:00.000Z" });
    const guest = request({ trip_shape: "one_way_to", origin_id: "stn", destination_id: "dest" });
    const draft = proposal({ type: "merge", ride_id: "ride1", payload: { ride_id: "ride1", legs: [{ ride_id: "ride1", role: "passenger", leg: "out", car_mode: "passenger" }] } });
    const server = new Map([["p1", { startsAt: "2026-10-11T05:30:00.000Z", endsAt: "2026-10-11T08:15:00.000Z" }]]);
    expect(resolveDraftPlacement(draft, [guest], [host], "home", { hop, stopMinutes: 5 }, server))
      .toMatchObject({ startsAt: "2026-10-11T05:30:00.000Z", endsAt: "2026-10-11T08:15:00.000Z" });
    // another proposal's window is not used; the twin fills in
    expect(resolveDraftPlacement(draft, [guest], [host], "home", { hop, stopMinutes: 5 }, new Map([["other", { startsAt: "2026-10-11T01:00:00.000Z", endsAt: "2026-10-11T09:00:00.000Z" }]])))
      .toMatchObject({ startsAt: "2026-10-11T05:45:00.000Z", endsAt: "2026-10-11T08:00:00.000Z" });
  });
  it("origin: the request's own window on the proposed car and place", () => {
    const placement = resolveDraftPlacement(proposal({ type: "origin", payload: { car_id: "carC", origin_id: "haifa" } }), [request()], []);
    expect(placement).toMatchObject({ type: "origin", carId: "carC", originId: "haifa", startsAt: "2026-10-11T06:00:00.000Z" });
  });
  it("deny and external drafts place nothing", () => {
    expect(resolveDraftPlacement(proposal({ type: "deny", payload: { reason: "x" } }), [request()], [])).toBeNull();
  });
});

describe("draft helpers", () => {
  it("resolveDraftPlacements skips sent proposals", () => {
    const sent = proposal({ id: "p2", status: "sent", payload: { car_id: "carB", depart_at: "2026-10-11T08:00:00.000Z" } });
    expect(resolveDraftPlacements([sent], [request()], [])).toEqual([]);
  });
  it("requestIdsWithOpenProposal covers draft/sent/accepted only", () => {
    const ids = requestIdsWithOpenProposal([
      { status: "draft", request_id: "a" }, { status: "sent", request_id: "b" }, { status: "accepted", request_id: "c" },
      { status: "withdrawn", request_id: "d" }, { status: "applied", request_id: "e" },
    ]);
    expect([...ids].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("plan B drafts (REQ §13.112 a)", () => {
  const payload = {
    car_id: "carA", return_car_id: "carB", depart_at: "2026-10-11T04:30:00.000Z", arrive_by: "2026-10-11T05:00:00.000Z",
    pickup_at: "2026-10-11T16:00:00.000Z", return_at: "2026-10-11T16:30:00.000Z", drop_place_id: "stn",
  };
  it("alternativeLegs: a drop-off block (twice the drive plus the dwell) and a pickup block ending when the member is back", () => {
    const legs = alternativeLegs(payload);
    expect(legs).toEqual([
      { leg: "out", carId: "carA", startsAt: "2026-10-11T04:30:00.000Z", endsAt: "2026-10-11T05:45:00.000Z" },
      { leg: "return", carId: "carB", startsAt: "2026-10-11T15:15:00.000Z", endsAt: "2026-10-11T16:30:00.000Z" },
    ]);
  });
  it("no pickup means only the drop-off block; an incomplete payload has none", () => {
    expect(alternativeLegs({ car_id: "carA", depart_at: payload.depart_at, arrive_by: payload.arrive_by })).toHaveLength(1);
    expect(alternativeLegs({ car_id: "carA" })).toEqual([]);
  });
  it("resolveDraftPlacement draws the drop-off block on the first car, keeps the request unplaced", () => {
    const placement = resolveDraftPlacement(proposal({ type: "alternative", payload }), [request()], [ride()], "home");
    expect(placement).toMatchObject({ type: "alternative", carId: "carA", leg: "out", startsAt: "2026-10-11T04:30:00.000Z", destinationId: "stn", originId: "home", replacesRideId: null });
    expect(resolveDraftPlacement(proposal({ type: "alternative", payload: {} }), [request()], [], "home")).toBeNull();
  });
});

describe("plan B draft with a pickup from another place", () => {
  it("the pickup block has no return_at: the car drives to the pickup place first", () => {
    const legs = alternativeLegs({ car_id: "carA", return_car_id: "carB", depart_at: "2026-10-11T04:30:00.000Z", arrive_by: "2026-10-11T05:00:00.000Z",
      pickup_at: "2026-10-11T16:00:00.000Z", pickup_place_id: "karkur" });
    expect(legs[1]).toEqual({ leg: "return", carId: "carB", startsAt: "2026-10-11T15:20:00.000Z", endsAt: "2026-10-11T16:30:00.000Z" });
  });
});
