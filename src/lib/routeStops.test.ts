import { describe, expect, it } from "vitest";

import { isActiveStop, parseRouteStops, routeStopNames, totalStopCount } from "./routeStops";

const raw = [
  { leg: "out", position: 0, place_id: "a", name: "A", eta: null },
  { leg: "return", position: 0, place_id: "b", name: "B", eta: null, active: true },
  { leg: "return", position: 1, place_id: "c", name: "C", eta: null, active: false },
];

describe("routeStops readers ignore inactive stops (REQ §13.97)", () => {
  it("parseRouteStops drops inactive stops unless asked", () => {
    expect(parseRouteStops(raw).map((s) => s.name)).toEqual(["A", "B"]);
    expect(parseRouteStops(raw, { includeInactive: true }).map((s) => s.name)).toEqual(["A", "B", "C"]);
  });
  it("names and count only see active stops", () => {
    const all = parseRouteStops(raw, { includeInactive: true });
    expect(routeStopNames(all, "return")).toEqual(["B"]);
    expect(totalStopCount(all)).toBe(2);
  });
});

describe("isActiveStop on rows without a computed flag (request_stops table, REQ §13.97)", () => {
  it("an out stop is always active", () => {
    expect(isActiveStop({ leg: "out" }, false)).toBe(true);
  });
  it("a return stop is active only when its request has a return", () => {
    expect(isActiveStop({ leg: "return" }, true)).toBe(true);
    expect(isActiveStop({ leg: "return" }, false)).toBe(false);
    expect(isActiveStop({ leg: "return" })).toBe(false);
  });
  it("a view's computed flag wins", () => {
    expect(isActiveStop({ leg: "return", active: true }, false)).toBe(true);
    expect(isActiveStop({ leg: "out", active: false }, true)).toBe(false);
  });
});
