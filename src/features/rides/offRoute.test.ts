import { describe, expect, it } from "vitest";

import type { RoutePoint } from "@/lib/rideRoute";

import { guestRoutePoints, losingPlacesText, removedPlaces } from "./offRoute";

const point = (over: Partial<RoutePoint>): RoutePoint => ({ leg: "out", position: 0, placeId: null, placeText: null, name: "", requestId: null, kind: "stop", eta: null, ...over });

describe("off-route helpers (silent drops item 3)", () => {
  it("a guest's places are where they board and get off", () => {
    const points = [
      point({ kind: "origin", placeId: "home", requestId: "host" }),
      point({ kind: "board", placeId: "home", requestId: "guest" }),
      point({ kind: "stop", placeId: "school", requestId: "host" }),
      point({ kind: "alight", placeText: " Gate ", requestId: "guest" }),
      point({ kind: "destination", placeId: "work", requestId: "host" }),
    ];
    expect(guestRoutePoints(points, "guest")).toEqual([{ leg: "out", place_id: "home" }, { leg: "out", place_text: "Gate" }]);
  });

  it("removed places: what a change drops, per leg, once per drop", () => {
    const before = [{ leg: "out" as const, placeId: "school" }, { leg: "out" as const, placeText: "Gate" }, { leg: "return" as const, placeId: "school" }];
    const after = [{ leg: "out" as const, placeText: "gate" }];
    expect(removedPlaces(before, after)).toEqual([{ leg: "out", place_id: "school" }, { leg: "return", place_id: "school" }]);
    expect(removedPlaces(before, before)).toEqual([]);
  });

  it("names and places once each, in order", () => {
    expect(losingPlacesText([{ name: "Noa", place: "A" }, { name: "Dan", place: "A" }, { name: "Noa", place: "B" }]))
      .toEqual({ names: "Noa, Dan", places: "A, B" });
  });
});
