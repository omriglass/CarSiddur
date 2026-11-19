import { describe, expect, it } from "vitest";

import type { RoutePoint } from "@/lib/rideRoute";

import type { RidePerson } from "./ridePeople";
import type { RideStretches } from "./rideStretches";
import { definiteConflicts, estimateMark, rideTimes, type RequestHours, type Stated } from "./rideTimes";

const at = (hhmm: string) => `2026-11-24T${hhmm}:00+02:00`;
const iso = (hhmm: string) => new Date(at(hhmm)).toISOString();

function point(leg: "out" | "return", position: number, name: string, eta: string, kind: RoutePoint["kind"] = "stop"): RoutePoint {
  return { leg, position, placeId: name, placeText: null, name, requestId: "qd", kind, eta: at(eta) };
}
const points: RoutePoint[] = [
  point("out", 0, "נבו", "07:45", "origin"),
  point("out", 1, "בנימינה", "08:20", "board"),
  point("out", 2, "חיפה", "08:50", "destination"),
  point("return", 0, "חיפה", "14:00", "origin"),
  point("return", 1, "נבו", "15:10", "destination"),
];
const stretches: RideStretches = {
  out: { spans: { "driver:d": [0, 2], "req:qy": [1, 2] }, absent: [], free: [3, 2, null] },
  return: { spans: { "driver:d": [0, 1] }, absent: ["req:qy"], free: [3, null] },
};
function person(key: string, source: RidePerson["source"], requestId: string | null, name: string): RidePerson {
  return { key, source, request_id: requestId, ride_passenger_id: null, person_id: null, child_id: null, display_name: name, seat_kind: "adult", added_by: null, removable: source !== "driver" };
}
const people = [person("driver:d", "driver", "qd", "דנה"), person("req:qy", "requester", "qy", "יואב"), person("comp:1", "companion", "qy", "גל")];
const dana: RequestHours = {
  id: "qd", trip_type: "round_trip", depart_at: at("07:45"), depart_anchor: "leave", flex_depart_early: "00:15:00", flex_depart_late: null,
  arrive_by: at("09:00"), return_at: at("15:15"), return_anchor: "leave", leave_dest_at: at("14:00"),
};
const yoav: RequestHours = { id: "qy", trip_type: "one_way", depart_at: at("08:15"), depart_anchor: "leave", flex_depart_late: "00:15:00" };

describe("rideTimes (SD1)", () => {
  it("lines up each person's asked hours with the ride's, an arrive-by 10 minutes ahead is tight", () => {
    const view = rideTimes({ points, stretches, people, requests: [dana, yoav], startsAt: at("07:45") });
    const d = view.people.find((p) => p.name === "דנה")!;
    expect(d.role).toBe("driver");
    expect(d.legs).toBe("both");
    expect(d.rows.map((r) => [r.leg, r.kind, r.place])).toEqual([
      ["out", "leave", "נבו"], ["out", "arriveBy", "חיפה"], ["return", "leave", "חיפה"], ["return", "back", "נבו"],
    ]);
    expect(d.rows[0]!.actual).toEqual({ at: at("07:45"), estimate: false });
    expect(d.rows[0]!.mark).toEqual({ kind: "ok" });
    expect(d.rows[1]!.mark).toEqual({ kind: "tight", minutes: 10 });
    expect(d.rows[3]!.stated).toBeNull();
    const y = view.people.find((p) => p.name === "יואב")!;
    expect(y.withNames).toEqual(["גל"]);
    expect(y.rows.map((r) => [r.kind, r.place, r.mark?.kind ?? null])).toEqual([["board", "בנימינה", "ok"], ["alight", "חיפה", null]]);
    expect(view.people).toHaveLength(2);
    expect(view.conflicts).toEqual([]);
  });

  it("the route view: hour, who gets on/off, each stated hour with its mark", () => {
    const view = rideTimes({ points, stretches, people, requests: [dana, yoav], startsAt: at("07:45") });
    const haifa = view.route.find((c) => c.leg === "out" && c.position === 2)!;
    expect(haifa.actual).toEqual({ at: at("08:50"), estimate: true });
    expect(haifa.off).toEqual(["דנה", "יואב", "גל"]);
    expect(haifa.tags.map((t) => [t.stated.name, t.stated.anchor, t.mark.kind])).toEqual([["דנה", "arrive", "tight"]]);
    expect(view.route.find((c) => c.position === 1 && c.leg === "out")!.on).toEqual(["יואב", "גל"]);
    expect(view.legs.map((l) => [l.leg, l.from?.estimate, l.to?.at])).toEqual([["out", false, at("08:50")], ["return", true, at("15:10")]]);
    expect(view.places).toEqual(["נבו", "בנימינה", "חיפה"]);
  });

  it("an estimate after an arrive-by is possibly late, by how much", () => {
    const view = rideTimes({ points, stretches, people, requests: [{ ...dana, arrive_by: at("08:40") }, yoav], startsAt: at("07:45") });
    expect(view.people[0]!.rows[1]!.mark).toEqual({ kind: "late", minutes: 10 });
  });

  it("two set hours that cannot both hold are a definite conflict (owner: I said 9:30, you said 9:00)", () => {
    const yoavBack: RequestHours = { ...yoav, trip_type: "round_trip", return_at: at("15:00"), return_anchor: "leave", leave_dest_at: at("13:30") };
    const both: RideStretches = { ...stretches, return: { spans: { "driver:d": [0, 1], "req:qy": [0, 1] }, absent: [], free: [2, null] } };
    const view = rideTimes({ points, stretches: both, people, requests: [dana, yoavBack], startsAt: at("07:45") });
    expect(view.conflicts).toHaveLength(1);
    expect([view.conflicts[0]!.a.name, view.conflicts[0]!.b.name].sort()).toEqual(["דנה", "יואב"]);
    expect(view.people.every((p) => p.conflicts.length === 1)).toBe(true);
    expect(view.route.find((c) => c.leg === "return" && c.position === 0)!.tags.every((t) => t.mark.kind === "conflict")).toBe(true);
  });

  it("the ride's set start against a person's leave-at", () => {
    const view = rideTimes({ points, stretches, people, requests: [{ ...dana, depart_at: at("07:30"), flex_depart_early: null, flex_depart_late: null }, yoav], startsAt: at("08:00") });
    expect(view.conflicts).toHaveLength(1);
    expect(view.conflicts.some((c) => c.a.rideStart || c.b.rideStart)).toBe(true);
    expect(view.people[0]!.rows[0]!.mark).toEqual({ kind: "conflict" });
  });
});

describe("one person on two of their own requests (owner 2026-11-19)", () => {
  // דנה drives her own ride and her second request (Binyamina) was merged into it: two people rows, one person
  const own = [
    { ...person("driver:d", "driver", "qd", "דנה"), person_id: "p-dana" },
    { ...person("req:qb", "requester", "qb", "דנה"), person_id: "p-dana" },
    person("req:qy", "requester", "qy", "יואב"),
  ];
  const second: RequestHours = { id: "qb", trip_type: "one_way", depart_at: at("08:30"), depart_anchor: "leave", flex_depart_late: null };
  const spans: RideStretches = {
    out: { spans: { "driver:d": [0, 2], "req:qb": [0, 1], "req:qy": [1, 2] }, absent: [], free: [3, 2, null] },
    return: { spans: { "driver:d": [0, 1] }, absent: ["req:qy", "req:qb"], free: [3, null] },
  };
  it("is one block, named once at each place, and their own two hours do not conflict", () => {
    const view = rideTimes({ points, stretches: spans, people: own, requests: [dana, second, yoav], startsAt: at("07:45") });
    expect(view.people.map((p) => p.name)).toEqual(["דנה", "יואב"]);
    expect(view.people[0]!.role).toBe("driver");
    expect(view.route.find((c) => c.leg === "out" && c.position === 0)!.on).toEqual(["דנה"]);
    expect(view.conflicts).toEqual([]);
  });
});

describe("definiteConflicts", () => {
  const s = (id: string, leg: "out" | "return", position: number, anchor: "arrive" | "leave", hhmm: string, late = 0): Stated =>
    ({ id, leg, position, anchor, at: iso(hhmm), early: 0, late, name: id });
  it("an arrival at a place may come before a departure from it", () => {
    expect(definiteConflicts([s("a", "out", 2, "arrive", "09:00"), s("b", "out", 2, "leave", "09:30")])).toEqual([]);
  });
  it("a departure after an arrive-by further on conflicts; its flexibility counts", () => {
    expect(definiteConflicts([s("a", "out", 1, "leave", "09:30"), s("b", "out", 2, "arrive", "09:00")])).toHaveLength(1);
    expect(definiteConflicts([s("a", "out", 1, "leave", "09:30"), s("b", "out", 2, "arrive", "09:00", 30)])).toEqual([]);
  });
  it("the way back comes after the way there", () => {
    expect(definiteConflicts([s("a", "out", 1, "leave", "14:00"), s("b", "return", 1, "arrive", "12:00")])).toHaveLength(1);
  });
});

describe("estimateMark", () => {
  const leave: Stated = { id: "x", leg: "out", position: 1, anchor: "leave", at: iso("08:15"), early: 0, late: 15, name: "x" };
  it("a car early at a leave-at is waiting, not late; later than the flexibility is late", () => {
    expect(estimateMark(leave, { at: iso("08:00"), estimate: true })).toEqual({ kind: "ok" });
    expect(estimateMark(leave, { at: iso("08:25"), estimate: true })).toEqual({ kind: "ok" });
    expect(estimateMark(leave, { at: iso("08:40"), estimate: true })).toEqual({ kind: "late", minutes: 10 });
  });
  it("any time that day never warns", () => {
    expect(estimateMark({ ...leave, late: 1440 }, { at: iso("20:00"), estimate: true })).toEqual({ kind: "ok" });
  });
});
