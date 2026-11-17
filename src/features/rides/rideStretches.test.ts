import { describe, expect, it } from "vitest";

import type { RoutePoint } from "@/lib/rideRoute";

import type { RidePerson } from "./ridePeople";
import {
  addPayload, baseRequestId, currentParts, partsFor, partsPayload, personDialogSetup, personSpan, personWhere, personWhereParts, roomFor, stopRows, withStatedHours,
  type RideStretches, type SummaryWords,
} from "./rideStretches";

// REQ item 246 h: עומרי drives נבו -> עין שמר (school) -> בנימינה (work) and back; the kids get off at school.
const pt = (leg: "out" | "return", position: number, name: string, placeId: string, kind: RoutePoint["kind"], eta: string, requestId = "q1"): RoutePoint =>
  ({ leg, position, placeId, placeText: null, name, requestId, kind, eta });
const points: RoutePoint[] = [
  pt("out", 0, "נבו", "nevo", "origin", "2026-11-19T05:55:00Z"),
  pt("out", 1, "עין שמר", "school", "stop", "2026-11-19T06:15:00Z"),
  pt("out", 2, "בנימינה", "work", "destination", "2026-11-19T07:30:00Z"),
  pt("return", 0, "בנימינה", "work", "destination", "2026-11-19T14:00:00Z"),
  pt("return", 1, "עין שמר", "school", "stop", "2026-11-19T14:30:00Z"),
  pt("return", 2, "נבו", "nevo", "origin", "2026-11-19T14:55:00Z"),
];
const person = (key: string, source: RidePerson["source"], name: string, extra: Partial<RidePerson> = {}): RidePerson => ({
  key, source, request_id: source === "added" ? null : "q1", ride_passenger_id: null, person_id: null, child_id: null,
  display_name: name, seat_kind: "adult", added_by: null, removable: source !== "driver", leg: "both", ...extra,
});
const omri = person("driver:o", "driver", "עומרי");
const noa = person("child:q1:n", "child", "נועה", { seat_kind: "child_seat" });
const maya = person("comp:q1:m", "companion", "מאיה");
const ron = person("added:r", "added", "רון", { leg: "return" });
const people = [omri, noa, maya, ron];
const stretches: RideStretches = {
  out: { spans: { "driver:o": [0, 2], "req:q1": [0, 2], "child:q1:n": [0, 1] }, absent: [], free: [1, 2] },
  return: { spans: { "driver:o": [0, 2], "req:q1": [0, 2], "child:q1:n": [1, 2], "added:r": [0, 2] }, absent: ["comp:q1:m"], free: [2, 1] },
};
const words: SummaryWords = {
  outOnly: "רק הלוך", returnOnly: "רק חזור",
  on: (name, time) => `↑ ${name}${time ? ` (${time})` : ""}`, off: (name, time) => `↓ ${name}${time ? ` (${time})` : ""}`,
};
const time = (iso: string) => iso.slice(11, 16);

describe("rideStretches", () => {
  it("a request's people without a row of their own ride the request's part; absent = not that way", () => {
    expect(personSpan(maya, stretches?.out)).toEqual([0, 2]);
    expect(personSpan(maya, stretches?.return)).toBeNull();
    expect(personSpan(ron, stretches?.out)).toBeNull();
  });

  it("the stops view: who gets off and on at each place (everyone at the start and the end), free seats on the next stretch", () => {
    const rows = stopRows(points, people, stretches);
    expect(rows.map((r) => [r.leg, r.point.name, r.off, r.on, r.free])).toEqual([
      ["out", "נבו", [], ["עומרי", "נועה", "מאיה"], 1],
      ["out", "עין שמר", ["נועה"], [], 2],
      ["out", "בנימינה", ["עומרי", "מאיה"], [], null],
      ["return", "בנימינה", [], ["עומרי", "רון"], 2],
      ["return", "עין שמר", [], ["נועה"], 1],
      ["return", "נבו", ["עומרי", "נועה", "רון"], [], null],
    ]);
  });

  it("the people summary: nothing for the whole ride, one way, else only the differences", () => {
    expect(personWhere(omri, points, stretches, words, time)).toBe("");
    expect(personWhere(maya, points, stretches, words, time)).toBe("רק הלוך");
    expect(personWhere(ron, points, stretches, words, time)).toBe("רק חזור");
    expect(personWhere(noa, points, stretches, words, time)).toBe("↓ עין שמר (06:15) · ↑ עין שמר (14:30)");
    // owner 2026-11-17: getting off / on are told apart, so the riders list can tint them
    expect(personWhereParts(noa, points, stretches, words, time).map((part) => part.kind)).toEqual(["off", "on"]);
    expect(personWhereParts(maya, points, stretches, words, time)).toEqual([{ text: "רק הלוך", kind: "plain" }]);
  });

  it("the dialog opens on the simplest choice that describes how someone rides", () => {
    expect(currentParts(omri, points, stretches).choice).toBe("whole");
    expect(currentParts(maya, points, stretches)).toEqual({ choice: "out", out: [0, 2], return: null });
    expect(currentParts(noa, points, stretches)).toEqual({ choice: "middle", out: [0, 1], return: [1, 2] });
  });

  it("payloads: places only where it is not the leg's start / end; the way back's own places on a both-ways row", () => {
    const kid = { choice: "middle" as const, out: [0, 1] as [number, number], return: [1, 2] as [number, number] };
    expect(partsPayload(kid, points)).toEqual({ out: { alight_place_id: "school" }, return: { board_place_id: "school" } });
    expect(addPayload(kid, points)).toEqual({ leg: "both", alight_place_id: "school", return_board_place_id: "school" });
    expect(addPayload(partsFor("return", points), points)).toEqual({ leg: "return" });
    expect(partsPayload({ choice: "out", out: [0, 2], return: null }, points)).toEqual({ out: {}, return: null });
  });

  it("room: every stretch they ride needs a seat; the edited person's own seat counts as theirs", () => {
    expect(roomFor(partsFor("whole", points), stretches, 1)).toBe(true);
    expect(roomFor(partsFor("whole", points), stretches, 2)).toBe(false);
    expect(roomFor({ choice: "middle", out: [1, 2], return: null }, stretches, 2)).toBe(true);
    // נועה getting the whole way out: the stretch to school is hers already
    expect(roomFor({ choice: "whole", out: [0, 2], return: [0, 2] }, stretches, 1, currentParts(noa, points, stretches))).toBe(true);
  });

  it("the edit dialog: the base request's people choose among its own places; a guest request's people ride whole ways", () => {
    expect(baseRequestId(points)).toBe("q1");
    const base = personDialogSetup(noa, points, stretches);
    expect(base).toMatchObject({ legs: ["out", "return"], middle: true, wholeLegsOnly: false, allowedPositions: { out: [0, 1, 2], return: [0, 1, 2] } });
    const guest = personDialogSetup(person("comp:q2:x", "companion", "x", { request_id: "q2", leg: "return" }), points,
      { ...stretches, return: { ...stretches!.return!, spans: { ...stretches!.return!.spans, "req:q2": [1, 2] } } });
    expect(guest).toMatchObject({ legs: ["return"], middle: false, wholeLegsOnly: true, initial: { choice: "whole", out: null, return: [0, 2] } });
    expect(personDialogSetup(ron, points, undefined).initial).toEqual({ choice: "return", out: null, return: [0, 2] });
  });

  it("stated hours beside the estimates: kept within the flexibility, else missed", () => {
    const at = (time: string, flex: number): RideStretches => ({ ...stretches, out: { ...stretches!.out!, fixed: [null, { at: time, anchor: "arrive", flex }, null] } });
    // the estimate at school is 06:15
    expect([...withStatedHours(points, at("2026-11-19T06:15:00Z", 0)).kept.keys()]).toEqual(["out:1"]);
    expect(withStatedHours(points, at("2026-11-19T06:00:00Z", 15)).kept.get("out:1")).toBe("2026-11-19T06:00:00Z");
    const missed = withStatedHours(points, at("2026-11-19T06:00:00Z", 10));
    expect(missed.kept.size).toBe(0);
    expect(missed.missed.get("out:1")).toBe("2026-11-19T06:00:00Z");
    expect(missed.points.find((p) => p.leg === "out" && p.position === 1)?.eta).toBe("2026-11-19T06:15:00Z");
  });
});
