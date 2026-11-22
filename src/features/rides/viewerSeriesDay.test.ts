import { describe, expect, it } from "vitest";

import type { BoardRide } from "./api";
import { viewerSeriesDay } from "./viewerSeriesDay";

// Day 1 of a two-day ride; a one-day trip rides along on its way out (QA run 22, R22B11/R22U10).
const ride = {
  id: "r", series_index: 1, series_count: 2,
  people: [
    { person_id: "tomer", request_id: "host", source: "driver" },
    { person_id: "shaked", request_id: "guest", source: "companion" },
    { person_id: "dana", request_id: "host", source: "companion" },
  ],
  served: [
    { request_id: "host", role: "driver", leg: "both" },
    { request_id: "guest", role: "passenger", leg: "out" },
  ],
} as unknown as BoardRide;

describe("viewerSeriesDay", () => {
  it("a one-day guest on a multi-day ride sees no day marker", () => {
    expect(viewerSeriesDay(ride, (id) => (id === "guest" ? { seriesIndex: null, seriesCount: null } : undefined)))
      .toEqual({ seriesIndex: null, seriesCount: null });
  });
  it("the multi-day trip's own people see its day", () => {
    expect(viewerSeriesDay(ride, (id) => (id === "host" ? { seriesIndex: 1, seriesCount: 2 } : undefined)))
      .toEqual({ seriesIndex: 1, seriesCount: 2 });
  });
  it("a companion (their request is not in their list once placed) - by the trip they ride on", () => {
    expect(viewerSeriesDay(ride, () => undefined, "shaked")).toEqual({ seriesIndex: null, seriesCount: null });
    expect(viewerSeriesDay(ride, () => undefined, "dana")).toEqual({ seriesIndex: 1, seriesCount: 2 });
  });
  it("with no trip of mine on it (I drive, I was added) the ride's own", () => {
    expect(viewerSeriesDay(ride, () => undefined)).toEqual({ seriesIndex: 1, seriesCount: 2 });
  });
});
