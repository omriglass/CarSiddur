import { describe, expect, it } from "vitest";

import { groupSeries, seriesSpanDays } from "./series";

describe("groupSeries", () => {
  it("groups legs sharing a seriesId, sorted by seriesIndex", () => {
    const rows = [
      { id: "a", seriesId: "s1", seriesIndex: 2 },
      { id: "b", seriesId: "s1", seriesIndex: 1 },
      { id: "c", seriesId: "s1", seriesIndex: 3 },
    ];
    expect(groupSeries(rows)).toEqual([[
      { id: "b", seriesId: "s1", seriesIndex: 1 },
      { id: "a", seriesId: "s1", seriesIndex: 2 },
      { id: "c", seriesId: "s1", seriesIndex: 3 },
    ]]);
  });

  it("gives every non-series row its own single-row group, preserving order", () => {
    const rows = [{ id: "a", seriesId: null }, { id: "b", seriesId: null }];
    expect(groupSeries(rows)).toEqual([[{ id: "a", seriesId: null }], [{ id: "b", seriesId: null }]]);
  });

  it("keeps a series group at the position of its first leg among mixed rows", () => {
    const rows = [
      { id: "solo", seriesId: null },
      { id: "leg1", seriesId: "s1", seriesIndex: 1 },
      { id: "leg2", seriesId: "s1", seriesIndex: 2 },
      { id: "other", seriesId: null },
    ];
    const groups = groupSeries(rows);
    expect(groups.map((g) => g.map((r) => r.id))).toEqual([["solo"], ["leg1", "leg2"], ["other"]]);
  });

  it("treats a missing seriesIndex as 0 for sorting", () => {
    const rows = [
      { id: "a", seriesId: "s1", seriesIndex: null },
      { id: "b", seriesId: "s1", seriesIndex: 1 },
    ];
    expect(groupSeries(rows).map((g) => g.map((r) => r.id))).toEqual([["a", "b"]]);
  });
});

describe("seriesSpanDays", () => {
  it("counts the departure and return day inclusively", () => {
    expect(seriesSpanDays("2026-09-15", "2026-09-15")).toBe(1);
    expect(seriesSpanDays("2026-09-15", "2026-09-17")).toBe(3);
  });

  it("counts a span crossing a month boundary", () => {
    expect(seriesSpanDays("2026-09-29", "2026-10-02")).toBe(4);
  });

  it("matches submit_series_request's own (last_date - first_date) + 1 for a >7 day span", () => {
    expect(seriesSpanDays("2026-09-13", "2026-09-21")).toBe(9);
  });
});
