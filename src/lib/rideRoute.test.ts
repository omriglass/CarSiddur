import { describe, expect, it } from "vitest";

import { fallbackRoute, homeTravelEdges, makeHop, makeHopKm, mergePassengerIntoRoute, parseRideRoute, roundUpRideEnd } from "./rideRoute";

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
  it("is symmetric, zero for the same place and defaults to 60 for unknown or free-text places", () => {
    expect(hop("D", "H")).toBe(60);
    expect(hop("H", "H")).toBe(0);
    expect(hop("H", "X")).toBe(60);
    expect(hop(null, "H")).toBe(60);
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
  it("inserts boarding before the destination and leaves earlier by the added out-leg driving (end kept)", () => {
    const merged = mergePassengerIntoRoute({
      route: hostRoute(), startsAt: START, endsAt: END, hop,
      passenger: { requestId: "r2", originId: "T", originName: "Station", destinationId: "D", destinationName: "Dest", leg: "out" },
    });
    // H -> T -> D = 20 + 45 + 5 dwell = 70 vs 60 direct: +10 minutes -> the start moves 07:15 -> 07:05 -> rounded down to 07:00
    expect(merged.addedMinutes).toBe(10);
    expect(merged.valid).toBe(true);
    expect(merged.route.map((p) => `${p.kind}:${p.placeId}`)).toEqual(["origin:H", "board:T", "destination:D"]);
    expect(merged.startsAt).toBe("2026-10-11T04:00:00.000Z");
    expect(merged.originalStartsAt).toBe(START);
    expect(merged.endsAt).toBe(END);
    expect(merged.boardLeg).toBe("out");
    expect(merged.boardEta).toBe("2026-10-11T04:20:00.000Z"); // 07:00 + 20 min
    expect(merged.route.at(-1)!.eta).toBe(new Date(Date.parse("2026-10-11T04:00:00.000Z") + 70 * 60_000).toISOString());
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

describe("mergePassengerIntoRoute validity (REQ §13.95 H1)", () => {
  const haifaHop = makeHop([
    { fromId: "H", toId: "HF", travelMinutes: 60 },
    { fromId: "H", toId: "AF", travelMinutes: 45 },
    { fromId: "HF", toId: "AF", travelMinutes: 40 },
  ]);
  const hostToHaifa = () => fallbackRoute({ startsAt: START, endsAt: END, originId: "H", destinationId: "HF" });

  it("refuses a guest who boards at the base's final destination (Haifa -> Afula onto home -> Haifa)", () => {
    const merged = mergePassengerIntoRoute({
      route: hostToHaifa(), startsAt: START, endsAt: END, hop: haifaHop,
      passenger: { requestId: "g", originId: "HF", destinationId: "AF", leg: "out" },
    });
    expect(merged.valid).toBe(false);
    expect(merged.invalid).toBe("boards_at_end");
    expect(merged.startsAt).toBe(START);
    expect(merged.route).toHaveLength(2);
  });

  it("refuses a guest whose boarding place is not on the way but cannot be inserted before the end", () => {
    const merged = mergePassengerIntoRoute({
      route: fallbackRoute({ startsAt: START, endsAt: END, originId: "H", destinationId: "HF" }), startsAt: START, endsAt: END, hop: haifaHop,
      passenger: { requestId: "g", originId: "HF", destinationId: "HF", leg: "out" },
    });
    expect(merged.invalid).toBe("boards_at_end");
  });

  it("refuses a detour over the minutes limit and accepts one within it", () => {
    const base = { route: hostToHaifa(), startsAt: START, endsAt: END, hop: haifaHop, passenger: { requestId: "g", originId: "AF", destinationId: "HF", leg: "out" as const } };
    // H -> AF -> HF = 45 + 40 + 5 = 90 vs 60: +30
    expect(mergePassengerIntoRoute({ ...base, detourLimitMinutes: 20 })).toMatchObject({ valid: false, invalid: "detour_too_long" });
    const ok = mergePassengerIntoRoute({ ...base, detourLimitMinutes: 30 });
    expect(ok.valid).toBe(true);
    expect(ok.addedOutMinutes).toBe(30);
    expect(ok.startsAt).toBe("2026-10-11T03:45:00.000Z"); // 07:15 - 30
  });

  it("does not apply the detour limit when a place on the merged leg is free text (unknown travel) and keeps the window", () => {
    const merged = mergePassengerIntoRoute({
      route: hostToHaifa(), startsAt: START, endsAt: END, hop: haifaHop, detourLimitMinutes: 20,
      passenger: { requestId: "g", originId: "H", destinationId: null, destinationText: "Train station", leg: "out" },
    });
    expect(merged.valid).toBe(true);
    expect(merged.addedOutMinutes).toBe(0);
    expect(merged.startsAt).toBe(START);
  });

  it("refuses a detour over the km limit when distances are known", () => {
    const hopKm = makeHopKm([
      { fromId: "H", toId: "HF", distanceKm: 70 },
      { fromId: "H", toId: "AF", distanceKm: 50 },
      { fromId: "HF", toId: "AF", distanceKm: 45 },
    ]);
    const merged = mergePassengerIntoRoute({
      route: hostToHaifa(), startsAt: START, endsAt: END, hop: haifaHop, hopKm, detourLimitMinutes: 60, detourLimitKm: 15,
      passenger: { requestId: "g", originId: "AF", destinationId: "HF", leg: "out" },
    });
    expect(merged.invalid).toBe("detour_too_long"); // 95 km vs 70 km
  });

  it("extends the end by the added return-leg driving and keeps the start", () => {
    const route = [
      ...hostToHaifa(),
      { leg: "return" as const, position: 0, placeId: "HF", placeText: null, name: "", requestId: null, kind: "origin" as const, eta: null },
      { leg: "return" as const, position: 1, placeId: "H", placeText: null, name: "", requestId: null, kind: "destination" as const, eta: END },
    ];
    const merged = mergePassengerIntoRoute({
      route, startsAt: START, endsAt: END, hop: haifaHop, detourLimitMinutes: 30,
      passenger: { requestId: "g", originId: "AF", destinationId: "HF", leg: "return" },
    });
    // return leg HF -> AF(alight) -> H: 40 + 5 + 45 = 90 vs 60: +30
    expect(merged.valid).toBe(true);
    expect(merged.startsAt).toBe(START);
    expect(merged.addedReturnMinutes).toBe(30);
    expect(merged.endsAt).toBe("2026-10-11T07:30:00.000Z");
  });
});

describe("roundUpRideEnd", () => {
  it("rounds up to a quarter hour and caps at 23:59 of the start's day", () => {
    expect(new Date(roundUpRideEnd(Date.parse(START), Date.parse("2026-10-11T07:01:00.000Z"))).toISOString()).toBe("2026-10-11T07:15:00.000Z");
    expect(new Date(roundUpRideEnd(Date.parse("2026-10-11T18:00:00.000Z"), Date.parse("2026-10-11T21:30:00.000Z"))).toISOString()).toBe("2026-10-11T20:59:00.000Z");
  });
});
