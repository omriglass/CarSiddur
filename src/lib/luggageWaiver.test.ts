import { describe, expect, it } from "vitest";

import { isLuggageWaived, isTowWaived, luggageMarker, needsLargeTrunk, needsTowHitch, towMarker } from "./luggageWaiver";

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

describe("towing (REQ §13.200: SQL request_needs_tow_hitch twin, one waiver for both needs)", () => {
  it("needs a hitch only when towing is asked and not waived", () => {
    expect(needsTowHitch({ needs_tow_hitch: true, luggage_waived_at: null })).toBe(true);
    expect(needsTowHitch({ needs_tow_hitch: true, luggage_waived_at: "2026-11-08T08:00:00Z" })).toBe(false);
    expect(needsTowHitch({ needs_tow_hitch: false })).toBe(false);
    expect(needsTowHitch({ has_luggage: true })).toBe(false);
  });
  it("labels only waived towing", () => {
    expect(isTowWaived({ needs_tow_hitch: true, luggage_waived_at: "2026-11-08T08:00:00Z" })).toBe(true);
    expect(isTowWaived({ needs_tow_hitch: false, luggage_waived_at: "2026-11-08T08:00:00Z" })).toBe(false);
  });
  it("towMarker follows the same none / needs / waived rule", () => {
    expect(towMarker([{ tow_hitch: false }])).toBe("none");
    expect(towMarker([{ tow_hitch: true }])).toBe("needs");
    expect(towMarker([{ tow_hitch: true, luggage_waived: true }])).toBe("waived");
  });
});
