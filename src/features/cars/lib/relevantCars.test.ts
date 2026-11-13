import { describe, expect, it } from "vitest";

import { activeCarCode, relevantCarIds } from "./relevantCars";

const ride = (over: Partial<Parameters<typeof relevantCarIds>[0][number]> = {}) => ({
  car_id: "c1", status: "confirmed", starts_at: "2026-11-15T08:00:00Z", ends_at: "2026-11-15T10:00:00Z", ...over,
});

describe("relevantCarIds (MC1)", () => {
  it("shows the car from 30 minutes before the start until the end", () => {
    expect(relevantCarIds([ride()], new Date("2026-11-15T07:29:00Z"))).toEqual([]);
    expect(relevantCarIds([ride()], new Date("2026-11-15T07:30:00Z"))).toEqual(["c1"]);
    expect(relevantCarIds([ride()], new Date("2026-11-15T09:59:00Z"))).toEqual(["c1"]);
    expect(relevantCarIds([ride()], new Date("2026-11-15T10:00:00Z"))).toEqual([]);
  });

  it("uses my own part of someone else's ride", () => {
    const part = ride({ my_part: { starts_at: "2026-11-15T09:30:00Z", ends_at: "2026-11-15T10:00:00Z" } });
    expect(relevantCarIds([part], new Date("2026-11-15T08:30:00Z"))).toEqual([]);
    expect(relevantCarIds([part], new Date("2026-11-15T09:15:00Z"))).toEqual(["c1"]);
  });

  it("skips unpublished, cancelled and car-less rides, cars listed already, and repeats", () => {
    const now = new Date("2026-11-15T09:00:00Z");
    expect(relevantCarIds([ride({ status: "draft" }), ride({ status: "cancelled" }), ride({ car_id: null })], now)).toEqual([]);
    expect(relevantCarIds([ride(), ride({ car_id: "c2", starts_at: "2026-11-15T07:45:00Z" }), ride()], now)).toEqual(["c2", "c1"]);
    expect(relevantCarIds([ride()], now, new Set(["c1"]))).toEqual([]);
  });
});

describe("activeCarCode", () => {
  it("is the replacement code while replaced", () => {
    expect(activeCarCode({ access_code: "1234", is_replaced: false, replacement_code: null })).toBe("1234");
    expect(activeCarCode({ access_code: "1234", is_replaced: true, replacement_code: "1234" })).toBe("1234");
    expect(activeCarCode({ access_code: "1234", is_replaced: true, replacement_code: "5678" })).toBe("5678");
    expect(activeCarCode({})).toBeNull();
  });
});
