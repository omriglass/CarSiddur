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
    const ms = (span: { depart_at: string; return_at: string } | null) => [Date.parse(span!.depart_at), Date.parse(span!.return_at)];
    expect(ms(buildSeriesSpan(legs, 0, 1))).toEqual([Date.parse(legs[0]!.departAt), Date.parse(legs[1]!.returnAt)]);
    expect(ms(buildSeriesSpan(legs, 1, 2))).toEqual([Date.parse(legs[1]!.departAt), Date.parse(legs[2]!.returnAt)]);
    expect(buildSeriesSpan(legs, 1, 1)).not.toBeNull();
  });
  it("a span ending on the last day starts at the series' real departure time, not the held-day 00:00 (REQ 105 d)", () => {
    const real = [
      { ...leg(1), departAt: "2026-10-12T05:00:00Z", returnAt: "2026-10-12T20:59:00Z" },
      { ...leg(2), departAt: "2026-10-12T21:00:00Z", returnAt: "2026-10-13T20:59:00Z" },
      { ...leg(3), departAt: "2026-10-13T21:00:00Z", returnAt: "2026-10-14T14:00:00Z" },
    ];
    expect(buildSeriesSpan(real, 2, 2)).toEqual({ depart_at: "2026-10-14T05:00:00.000Z", return_at: "2026-10-14T14:00:00Z" });
    expect(buildSeriesSpan(real, 1, 1)?.depart_at).toBe("2026-10-13T05:00:00.000Z");
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
