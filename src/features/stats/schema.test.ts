import { describe, expect, it } from "vitest";

import { departmentStatsSchema, rideTypeStatSchema, weekdayStatSchema, weeklyStatSchema } from "./schema";

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

  it("parses without the new optional fields (old RPC shape still renders)", () => {
    expect(() => departmentStatsSchema.parse(stats)).not.toThrow();
    const parsed = departmentStatsSchema.parse(stats);
    expect(parsed.requests.servedRate).toBeUndefined();
    expect(parsed.distinctPeople).toBeUndefined();
    expect(parsed.distinctDrivers).toBeUndefined();
    expect(parsed.byRideType).toBeUndefined();
    expect(parsed.weekly).toBeUndefined();
  });

  it("parses the new optional fields when the RPC provides them", () => {
    const extended = {
      ...stats,
      requests: { ...stats.requests, servedRate: 0.857 },
      distinctPeople: 37,
      distinctDrivers: 21,
      byRideType: [
        { rideTypeId: "11111111-1111-1111-1111-111111111111", code: "work", name: "עבודה", rides: 80, hours: 210.5 },
        { rideTypeId: null, code: "other", name: null, rides: 5, hours: 6 },
      ],
      weekly: [
        { weekStart: "2026-08-02", total: 40, granted: 35, unmet: 3, cancelled: 2, rides: 33, provisional: false },
        { weekStart: "2026-08-09", total: 12, granted: 10, unmet: 2, cancelled: 0, rides: 9, provisional: true },
      ],
    };
    const parsed = departmentStatsSchema.parse(extended);
    expect(parsed.requests.servedRate).toBe(0.857);
    expect(parsed.distinctPeople).toBe(37);
    expect(parsed.byRideType).toHaveLength(2);
    expect(parsed.weekly).toHaveLength(2);
  });
});

describe("rideTypeStatSchema", () => {
  it("accepts a nullable rideTypeId/name", () => {
    const row = { rideTypeId: null, code: "other", name: null, rides: 5, hours: 6 };
    expect(rideTypeStatSchema.parse(row)).toEqual(row);
  });
});

describe("weeklyStatSchema", () => {
  it("parses a weekly row", () => {
    const row = { weekStart: "2026-08-02", total: 40, granted: 35, unmet: 3, cancelled: 2, rides: 33, provisional: false };
    expect(weeklyStatSchema.parse(row)).toEqual(row);
  });
});
