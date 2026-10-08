import { describe, expect, it } from "vitest";

import { luggageCountOf, luggageWarns, requestsNeedingSmallTrunkWaiver } from "./dropValidity";

import type { BoardDropContext } from "./dropValidity";
import type { BoardRide } from "../api";

const ride = (id: string, luggage: number, waived = 0) => ({
  id,
  served: Array.from({ length: Math.max(1, luggage) }, (_, i) => ({
    request_id: `${id}-${i}`, role: i === 0 ? "driver" : "passenger", luggage: i < luggage, luggage_waived: i < waived,
  })),
}) as unknown as BoardRide;
const ctx = {
  cars: [{ id: "big", features: ["large_trunk"] }, { id: "small", features: [] }],
} as unknown as Pick<BoardDropContext, "cars">;

describe("luggageWarns (REQ §13.111 a: a warning, no longer a refusal)", () => {
  it("warns for a car without large_trunk, never for one with it or for no luggage", () => {
    expect(luggageWarns(ctx, "small", 1)).toBe(true);
    expect(luggageWarns(ctx, "big", 1)).toBe(false);
    expect(luggageWarns(ctx, "small", 0)).toBe(false);
  });
  it("has no per-car count: any number of luggage requests fit one large-trunk car", () => {
    expect(luggageWarns(ctx, "big", 5)).toBe(false);
    expect(luggageWarns(ctx, "small", 5)).toBe(true);
  });
});

describe("luggageCountOf", () => {
  it("counts only the large-luggage requests that still need a large trunk", () => {
    expect(luggageCountOf(ride("a", 3))).toBe(3);
    expect(luggageCountOf(ride("a", 3, 2))).toBe(1);
    expect(luggageCountOf(ride("a", 0))).toBe(0);
  });
});

describe("requestsNeedingSmallTrunkWaiver", () => {
  const requests = [
    { id: "needs", has_luggage: true, luggage_waived_at: null },
    { id: "waived", has_luggage: true, luggage_waived_at: "2026-10-17T08:00:00Z" },
    { id: "none", has_luggage: false, luggage_waived_at: null },
  ];
  it("lists the requests that need the waiver on a small car", () => {
    expect(requestsNeedingSmallTrunkWaiver(ctx, "small", requests).map((request) => request.id)).toEqual(["needs"]);
  });
  it("lists nothing on a large-trunk car", () => {
    expect(requestsNeedingSmallTrunkWaiver(ctx, "big", requests)).toEqual([]);
  });
});
