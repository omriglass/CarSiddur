import { describe, expect, it } from "vitest";

import { requestRoutePoints, riderParts, ridersOfPeople, rowSpan, withRiderParts, type RiderRow } from "./riders";

// REQ item 246 h: נבו -> עין שמר (school) -> בנימינה and back the same way; the kids get off at school.
const nevo = { presetId: "nevo", name: "נבו" };
const school = { presetId: "school", name: "עין שמר" };
const work = { presetId: "work", name: "בנימינה" };
const points = requestRoutePoints({ origin: nevo, destination: work, outStops: [school], returnStops: [school], hasReturn: true }, (v) => (v && "name" in v ? v.name : ""));
const kidRows: RiderRow[] = [
  { rider_key: "child:k", leg: "out", rides: true, seat_kind: "child_seat", alight_place_id: "school" },
  { rider_key: "child:k", leg: "return", rides: true, seat_kind: "child_seat", board_place_id: "school" },
];

describe("riders (the request form)", () => {
  it("the request's route: the way there and back over its own stops", () => {
    expect(points.map((p) => `${p.leg}:${p.name}`)).toEqual(["out:נבו", "out:עין שמר", "out:בנימינה", "return:בנימינה", "return:עין שמר", "return:נבו"]);
  });

  it("a row's span: places by first match; no row = the whole leg; a place off the route = the whole leg", () => {
    const out = points.filter((p) => p.leg === "out");
    expect(rowSpan(undefined, out)).toEqual([0, 2]);
    expect(rowSpan(kidRows[0], out)).toEqual([0, 1]);
    expect(rowSpan({ rider_key: "guest:1", leg: "out", rides: true, board_place_id: "haifa" }, out)).toEqual([0, 2]);
    expect(rowSpan({ rider_key: "guest:1", leg: "out", rides: false }, out)).toBeNull();
  });

  it("parts and back: the kid off at school and on there on the way back; the whole ride stores nothing", () => {
    const parts = riderParts("child:k", kidRows, points);
    expect(parts).toEqual({ choice: "middle", out: [0, 1], return: [1, 2] });
    expect(withRiderParts([], "child:k", "child_seat", parts, points)).toEqual(kidRows);
    expect(withRiderParts(kidRows, "child:k", "child_seat", { choice: "whole", out: [0, 2], return: [0, 2] }, points)).toEqual([]);
    expect(withRiderParts([], "companion:m", "adult", { choice: "out", out: [0, 2], return: null }, points))
      .toEqual([{ rider_key: "companion:m", leg: "return", rides: false, seat_kind: "adult" }]);
  });

  it("a one-way request keeps its way-back rows untouched", () => {
    const oneWay = requestRoutePoints({ origin: nevo, destination: work, outStops: [school], returnStops: [school], hasReturn: false }, () => "");
    expect(withRiderParts(kidRows, "child:k", "child_seat", { choice: "whole", out: [0, 2], return: null }, oneWay)).toEqual([kidRows[1]]);
  });

  it("only the people still on the request are sent", () => {
    const rows: RiderRow[] = [...kidRows, { rider_key: "companion:gone", leg: "out", rides: false }, { rider_key: "guest:3", leg: "out", rides: false },
      { rider_key: "guest:1", leg: "out", rides: false }];
    expect(ridersOfPeople(rows, { companions: [], children: ["k"], guests: 2 }).map((r) => r.rider_key)).toEqual(["child:k", "child:k", "guest:1"]);
  });
});
