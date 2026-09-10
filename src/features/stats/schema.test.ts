import { describe, expect, it } from "vitest";

import { departmentStatsSchema, weekdayStatSchema } from "./schema";

const weekday = { dow: 0, occurrences: 6, avgActiveHours: 4.2, avgRides: 5.1, utilizationRate: 0.09 };

const stats = {
  from: "2026-08-01",
  to: "2026-09-10",
  days: 41,
  sharedCars: 3,
  utilization: { activeHours: 123.5, capacityHours: 1968, rate: 0.0628 },
  requests: { total: 210, granted: 180, unmet: 22, cancelled: 8, unmetRate: 0.1048 },
  rides: 174,
  byWeekday: Array.from({ length: 7 }, (_, dow) => ({ ...weekday, dow })),
  policyScore: { average: 0.83, weeks: 5 },
};

describe("weekdayStatSchema", () => {
  it("parses a valid weekday row", () => {
    expect(weekdayStatSchema.parse(weekday)).toEqual(weekday);
  });

  it("rejects a dow outside 0..6", () => {
    expect(() => weekdayStatSchema.parse({ ...weekday, dow: 7 })).toThrow();
  });
});

describe("departmentStatsSchema", () => {
  it("parses the department_stats jsonb shape", () => {
    expect(departmentStatsSchema.parse(stats)).toEqual(stats);
  });

  it("requires exactly 7 byWeekday entries", () => {
    expect(() => departmentStatsSchema.parse({ ...stats, byWeekday: stats.byWeekday.slice(0, 6) })).toThrow();
  });

  it("accepts a null policyScore.average (no weeks published in range)", () => {
    const parsed = departmentStatsSchema.parse({ ...stats, policyScore: { average: null, weeks: 0 } });
    expect(parsed.policyScore.average).toBeNull();
  });

  it("rejects a missing required field", () => {
    const rest = Object.fromEntries(Object.entries(stats).filter(([key]) => key !== "rides"));
    expect(() => departmentStatsSchema.parse(rest)).toThrow();
  });
});
