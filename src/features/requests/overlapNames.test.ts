import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";

import { overlapNames, overlapRefusalMessage } from "./overlapNames";

const mine = [
  { id: "r1", destination: "Harish", departAt: "2026-10-12T05:00:00Z", returnAt: "2026-10-12T07:00:00Z", ride: null },
  { id: "r2", destination: "Haifa", departAt: null, returnAt: null, ride: { id: "ride2", startsAt: "2026-10-13T05:00:00Z", endsAt: "2026-10-13T06:00:00Z" } },
] as never;

describe("overlapNames", () => {
  it("names overlapping requests and rides, drops unknown ids", () => {
    const names = overlapNames([{ request_id: "r1", ride_id: null }, { request_id: null, ride_id: "ride2" }, { request_id: "x", ride_id: null }], mine);
    expect(names).toHaveLength(2);
    expect(names[0]).toContain("Harish");
    expect(names[0]).toContain("08:00–10:00");
    expect(names[1]).toContain("Haifa");
  });
  it("falls back to a generic sentence and never the raw code", () => {
    expect(overlapRefusalMessage([])).toBe(he.request.overlapRefused);
    expect(overlapRefusalMessage(["A"])).not.toContain("DUPLICATE_OVERLAP");
  });
});
