import { describe, expect, it } from "vitest";

import { activeSeriesLegs, buildSeriesSpan, seriesHead, seriesSpanPrefill } from "./seriesSpan";

import type { SeriesLeg } from "../api";

const leg = (i: number, status = "waitlisted"): SeriesLeg => ({
  id: `l${i}`, seriesIndex: i, seriesCount: 3, status, version: 1,
  departAt: `2026-10-1${i}T07:00:00Z`, returnAt: `2026-10-1${i}T20:59:00Z`,
});

describe("seriesSpan", () => {
  const legs = [leg(1), leg(2), leg(3)];
  it("builds a consecutive strictly-shorter sub-span", () => {
    expect(buildSeriesSpan(legs, 0, 1)).toEqual({ depart_at: legs[0]!.departAt, return_at: legs[1]!.returnAt });
    expect(buildSeriesSpan(legs, 1, 2)).toEqual({ depart_at: legs[1]!.departAt, return_at: legs[2]!.returnAt });
    expect(buildSeriesSpan(legs, 1, 1)).not.toBeNull();
  });
  it("refuses the whole series, an inverted or an out-of-range span", () => {
    expect(buildSeriesSpan(legs, 0, 2)).toBeNull();
    expect(buildSeriesSpan(legs, 2, 1)).toBeNull();
    expect(buildSeriesSpan(legs, 0, 5)).toBeNull();
  });
  it("skips withdrawn legs and finds the head", () => {
    expect(activeSeriesLegs([leg(1, "withdrawn"), leg(2)]).map((l) => l.id)).toEqual(["l2"]);
    expect(seriesHead([leg(2), leg(1)])?.id).toBe("l1");
  });
  it("prefills a shift with car and span", () => {
    expect(seriesSpanPrefill("h", "c", { depart_at: "a", return_at: "b" })).toEqual({ requestId: "h", rideId: null, type: "shift", payload: { car_id: "c", series_span: { depart_at: "a", return_at: "b" } } });
  });
});
