import { describe, expect, it } from "vitest";

import { fallbackRoute, homeTravelEdges, makeHop, mergePassengerIntoRoute, parseRideRoute, roundUpRideEnd } from "./rideRoute";

const hop = makeHop([
  { fromId: "H", toId: "D", travelMinutes: 60 },
  { fromId: "H", toId: "T", travelMinutes: 20 },
  { fromId: "T", toId: "D", travelMinutes: 45 },
]);

const START = "2026-10-11T04:15:00.000Z"; // 07:15 Jerusalem (UTC+3)
const END = "2026-10-11T07:00:00.000Z"; // 10:00

function hostRoute() {
  return fallbackRoute({ startsAt: START, endsAt: END, originId: "H", originName: "Home", destinationId: "D", destinationName: "Dest" });
}

describe("makeHop", () => {
  it("is symmetric, zero for the same place and defaults to 30 for unknown or free-text places", () => {
    expect(hop("D", "H")).toBe(60);
    expect(hop("H", "H")).toBe(0);
    expect(hop("H", "X")).toBe(30);
    expect(hop(null, "H")).toBe(30);
  });
});

describe("homeTravelEdges", () => {
  it("prices home to a preset place at its stored minutes instead of the 30 min fallback", () => {
    const edges = homeTravelEdges("H", [{ id: "H", travel_minutes: 0 }, { id: "D", travel_minutes: 20 }, { id: "X", travel_minutes: null }]);
    expect(edges).toEqual([{ fromId: "H", toId: "D", travelMinutes: 20 }]);
    expect(makeHop(edges)("D", "H")).toBe(20);
    expect(homeTravelEdges(null, [{ id: "D", travel_minutes: 20 }])).toEqual([]);
  });
});

describe("parseRideRoute", () => {
  it("reads v_board_rides.route in leg/position order and drops malformed rows", () => {
    const parsed = parseRideRoute([
      { leg: "return", position: 0, place_id: "D", name: "Dest", kind: "origin", eta: null },
      { leg: "out", position: 1, place_id: "D", name: "Dest", kind: "destination", eta: START },
      { leg: "out", position: 0, place_id: "H", place_text: null, name: "Home", kind: "origin", eta: START },
      { leg: "sideways", position: 0, kind: "stop" },
      "junk",
    ]);
    expect(parsed.map((p) => `${p.leg}:${p.position}`)).toEqual(["out:0", "out:1", "return:0"]);
  });
});

describe("mergePassengerIntoRoute", () => {
  it("inserts boarding before the destination, keeps the start and extends the end by the added driving", () => {
    const merged = mergePassengerIntoRoute({
      route: hostRoute(), startsAt: START, endsAt: END, hop,
      passenger: { requestId: "r2", originId: "T", originName: "Station", destinationId: "D", destinationName: "Dest", leg: "out" },
    });
    // H -> T -> D = 20 + 45 + 5 dwell = 70 vs 60 direct: +10 minutes -> rounded to a quarter hour
    expect(merged.addedMinutes).toBe(10);
    expect(merged.route.map((p) => `${p.kind}:${p.placeId}`)).toEqual(["origin:H", "board:T", "destination:D"]);
    expect(merged.startsAt).toBe(START);
    expect(merged.endsAt).toBe("2026-10-11T07:15:00.000Z");
    expect(merged.boardLeg).toBe("out");
    expect(merged.boardEta).toBe("2026-10-11T04:35:00.000Z");
  });

  it("does not duplicate a place already on the route and never shortens", () => {
    const merged = mergePassengerIntoRoute({
      route: hostRoute(), startsAt: START, endsAt: END, hop,
      passenger: { requestId: "r2", originId: "H", destinationId: "D", leg: "out" },
    });
    expect(merged.addedMinutes).toBe(0);
    expect(merged.endsAt).toBe(END);
    expect(merged.route).toHaveLength(2);
  });

  it("skips a leg the host does not cover and mirrors boarding on the return leg", () => {
    const route = [
      ...hostRoute(),
      { leg: "return" as const, position: 0, placeId: "D", placeText: null, name: "Dest", requestId: null, kind: "origin" as const, eta: null },
      { leg: "return" as const, position: 1, placeId: "H", placeText: null, name: "Home", requestId: null, kind: "destination" as const, eta: END },
    ];
    const merged = mergePassengerIntoRoute({
      route, startsAt: START, endsAt: END, hop,
      passenger: { requestId: "r2", originId: "T", destinationId: "D", leg: "return" },
    });
    const ret = merged.route.filter((p) => p.leg === "return").map((p) => `${p.kind}:${p.placeId}`);
    // returning passenger boards at D (their destination) and alights at T (their origin)
    expect(ret).toEqual(["origin:D", "alight:T", "destination:H"]);
    expect(merged.route.filter((p) => p.leg === "out")).toHaveLength(2);
    expect(merged.boardLeg).toBe("return");
  });

  it("gives a board ETA when the passenger boards at a place already on the route (the host's origin)", () => {
    const merged = mergePassengerIntoRoute({
      route: hostRoute(), startsAt: START, endsAt: END, hop,
      passenger: { requestId: "r1", originId: "H", destinationId: "D", leg: "out" },
    });
    expect(merged.boardLeg).toBe("out");
    expect(merged.boardEta).toBe(START);
  });

  it("returns no board ETA when the host has no leg for the passenger", () => {
    const merged = mergePassengerIntoRoute({
      route: hostRoute(), startsAt: START, endsAt: END, hop,
      passenger: { requestId: "r2", originId: "T", destinationId: "D", leg: "return" },
    });
    expect(merged.boardEta).toBeNull();
    expect(merged.addedMinutes).toBe(0);
  });
});

describe("roundUpRideEnd", () => {
  it("rounds up to a quarter hour and caps at 23:59 of the start's day", () => {
    expect(new Date(roundUpRideEnd(Date.parse(START), Date.parse("2026-10-11T07:01:00.000Z"))).toISOString()).toBe("2026-10-11T07:15:00.000Z");
    expect(new Date(roundUpRideEnd(Date.parse("2026-10-11T18:00:00.000Z"), Date.parse("2026-10-11T21:30:00.000Z"))).toISOString()).toBe("2026-10-11T20:59:00.000Z");
  });
});
