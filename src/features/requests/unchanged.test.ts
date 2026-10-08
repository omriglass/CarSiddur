import { describe, expect, it } from "vitest";

import { REQUEST_FORM_DEFAULTS, type RequestFormValues } from "./schema";
import { editSignature, isUnchangedEdit } from "./unchanged";

const base: RequestFormValues = {
  ...REQUEST_FORM_DEFAULTS,
  departmentId: "d1",
  weekStart: "2026-10-11",
  day: "2026-10-13",
  dayIndex: 2,
  rideTypeId: "rt",
  destination: { presetId: "dest", name: "A" },
  origin: { presetId: "home", name: "H" },
};

describe("isUnchangedEdit (R11B1)", () => {
  const classic = { anchorSync: false };
  const sentence = { anchorSync: true };
  const baseline = editSignature(base, classic);

  it("is true for identical values", () => {
    expect(isUnchangedEdit({ ...base }, baseline, classic)).toBe(true);
  });
  it("is false without a baseline (not loaded yet)", () => {
    expect(isUnchangedEdit(base, null, classic)).toBe(false);
  });
  it("sees a changed time, note, person or place", () => {
    expect(isUnchangedEdit({ ...base, returnTime: "13:00" }, baseline, classic)).toBe(false);
    expect(isUnchangedEdit({ ...base, notes: "x" }, baseline, classic)).toBe(false);
    expect(isUnchangedEdit({ ...base, companions: ["p1"] }, baseline, classic)).toBe(false);
    expect(isUnchangedEdit({ ...base, outStops: [{ freeText: "stop" }] }, baseline, classic)).toBe(false);
    expect(isUnchangedEdit({ ...base, extraAdults: 1 }, baseline, classic)).toBe(false);
  });
  it("ignores the order of companions and children", () => {
    const left = editSignature({ ...base, companions: ["a", "b"], children: ["x", "y"] }, classic);
    expect(isUnchangedEdit({ ...base, companions: ["b", "a"], children: ["y", "x"] }, left, classic)).toBe(true);
  });
  it("ignores the derived car time of an anchored end (the sentence layout re-derives it)", () => {
    const anchored: RequestFormValues = { ...base, departAnchor: "arrive", arriveByTime: "09:30", departTime: "08:45", returnAnchor: "leave", leaveDestTime: "13:00", returnTime: "14:15" };
    const sig = editSignature(anchored, sentence);
    expect(isUnchangedEdit({ ...anchored, departTime: "08:30", returnTime: "14:30" }, sig, sentence)).toBe(true);
    expect(isUnchangedEdit({ ...anchored, arriveByTime: "10:00" }, sig, sentence)).toBe(false);
  });
});
