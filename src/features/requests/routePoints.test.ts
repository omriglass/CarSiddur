import { describe, expect, it } from "vitest";

import { hasDestination, outboundRoutePoints, returnRoutePoints } from "./routePoints";
import { recentDestinations } from "./recentDestinations";

const origin = { presetId: "home", name: "Home" };
const destination = { presetId: "haifa", name: "Haifa" };

describe("route points", () => {
  it("outbound is origin, out stops, destination; the return is destination, return stops, origin", () => {
    const values = { origin, destination, outStops: [{ freeText: " mall " }], returnStops: [{ presetId: "afula", name: "Afula" }] };
    expect(outboundRoutePoints(values)).toEqual([
      { place_id: "home", place_text: null },
      { place_id: null, place_text: "mall" },
      { place_id: "haifa", place_text: null },
    ]);
    expect(returnRoutePoints(values)).toEqual([
      { place_id: "haifa", place_text: null },
      { place_id: "afula", place_text: null },
      { place_id: "home", place_text: null },
    ]);
  });

  it("an empty free-text origin is an unknown point", () => {
    expect(outboundRoutePoints({ origin: { freeText: "" }, destination, outStops: [], returnStops: [] })[0]).toEqual({ place_id: null, place_text: null });
  });

  it("hasDestination needs a real value", () => {
    expect(hasDestination({ freeText: "  " })).toBe(false);
    expect(hasDestination(destination)).toBe(true);
  });
});

describe("recentDestinations", () => {
  const row = (departAt: string, destination: string, destinationId: string | null, status = "assigned") => ({
    departAt, returnAt: null, status, destination, destinationId, destinationText: destinationId ? null : destination,
  });

  it("returns the last four distinct destinations, newest first, skipping withdrawn", () => {
    const rows = [
      row("2026-10-01T08:00:00Z", "A", "a"),
      row("2026-10-02T08:00:00Z", "B", "b"),
      row("2026-10-03T08:00:00Z", "A", "a"),
      row("2026-10-04T08:00:00Z", "free", null),
      row("2026-10-05T08:00:00Z", "C", "c"),
      row("2026-10-06T08:00:00Z", "D", "d", "withdrawn"),
      row("2026-10-07T08:00:00Z", "E", "e"),
    ];
    expect(recentDestinations(rows).map((v) => ("presetId" in v ? v.presetId : v.freeText))).toEqual(["e", "c", "free", "a"]);
  });
});
