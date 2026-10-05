import { describe, expect, it } from "vitest";

import { luggageBlocks, swapLuggageBlocked } from "./dropValidity";

import type { BoardDropContext } from "./dropValidity";

const ride = (id: string, carId: string, luggage: number, startsAt = "2026-10-12T07:00:00Z", endsAt = "2026-10-12T09:00:00Z") => ({
  id, car_id: carId, status: "approved", starts_at: startsAt, ends_at: endsAt,
  served: Array.from({ length: Math.max(1, luggage) }, (_, i) => ({ request_id: `${id}-${i}`, role: i === 0 ? "driver" : "passenger", luggage: i < luggage })),
});
const ctx = (rides: unknown[]) => ({
  cars: [{ id: "big", features: ["large_trunk"] }, { id: "small", features: [] }],
  rides,
}) as unknown as Pick<BoardDropContext, "cars" | "rides">;

describe("luggageBlocks", () => {
  it("refuses a car without large_trunk, allows one with it", () => {
    expect(luggageBlocks(ctx([]), "small", 1)).toBe(true);
    expect(luggageBlocks(ctx([]), "big", 1)).toBe(false);
    expect(luggageBlocks(ctx([]), "small", 0)).toBe(false);
  });
  it("allows at most two overlapping luggage requests", () => {
    const rides = [ride("a", "big", 2)];
    expect(luggageBlocks(ctx(rides), "big", 1, { startsAt: "2026-10-12T08:00:00Z", endsAt: "2026-10-12T10:00:00Z" })).toBe(true);
    expect(luggageBlocks(ctx(rides), "big", 1, { startsAt: "2026-10-12T10:00:00Z", endsAt: "2026-10-12T11:00:00Z" })).toBe(false);
    expect(luggageBlocks(ctx(rides), "big", 1, null, ["a"])).toBe(false);
  });
});

describe("swapLuggageBlocked", () => {
  it("blocks moving a luggage ride to a car without a trunk", () => {
    expect(swapLuggageBlocked(ctx([ride("a", "big", 1)]), "big", "small", "2026-10-12")).toBe(true);
    expect(swapLuggageBlocked(ctx([ride("a", "big", 0)]), "big", "small", "2026-10-12")).toBe(false);
  });
});
