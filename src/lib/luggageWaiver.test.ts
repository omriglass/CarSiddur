import { describe, expect, it } from "vitest";

import { isLuggageWaived, luggageMarker, needsLargeTrunk } from "./luggageWaiver";

describe("luggage waiver rule (SQL request_needs_large_trunk twin)", () => {
  it("needs a large trunk only when there is large luggage and no waiver", () => {
    expect(needsLargeTrunk({ has_luggage: true, luggage_waived_at: null })).toBe(true);
    expect(needsLargeTrunk({ has_luggage: true })).toBe(true);
    expect(needsLargeTrunk({ has_luggage: true, luggage_waived_at: "2026-10-17T08:00:00Z" })).toBe(false);
    expect(needsLargeTrunk({ has_luggage: false, luggage_waived_at: null })).toBe(false);
    expect(needsLargeTrunk({ has_luggage: null })).toBe(false);
  });
  it("labels only waived large luggage", () => {
    expect(isLuggageWaived({ has_luggage: true, luggage_waived_at: "2026-10-17T08:00:00Z" })).toBe(true);
    expect(isLuggageWaived({ has_luggage: true, luggage_waived_at: null })).toBe(false);
    expect(isLuggageWaived({ has_luggage: false, luggage_waived_at: "2026-10-17T08:00:00Z" })).toBe(false);
  });
});

describe("luggageMarker (ride block chip)", () => {
  it("is none without luggage, needs while any luggage still needs a trunk, waived once all of it is waived", () => {
    expect(luggageMarker([{ luggage: false }])).toBe("none");
    expect(luggageMarker([{ luggage: true }, { luggage: false }])).toBe("needs");
    expect(luggageMarker([{ luggage: true, luggage_waived: true }, { luggage: true }])).toBe("needs");
    expect(luggageMarker([{ luggage: true, luggage_waived: true }, { luggage: false }])).toBe("waived");
  });
});
