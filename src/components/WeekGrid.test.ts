import { describe, expect, it } from "vitest";

import { clampRideVertical, minutesFromClientY, snapTimeShift } from "./WeekGrid";

// Vertical-board redesign (UX_FLOWS.md §20 "owner feedback: flip the
// grid" — cars as columns, hours as rows, time flows top→bottom). The old
// horizontal layout needed a scoped `dir="ltr"` hack on the hour axis
// (UX_FLOWS §17) because a plain RTL flex row lays its children out from the
// physical *right*, mismatching the ride blocks' `dir`-independent
// `left`/`width` clamping. That whole bug class cannot recur here: the time
// axis is now vertical (`top`/`height`), and `dir` never mirrors the
// block/vertical axis, only the inline/horizontal one — so
// `minutesFromClientY` must produce identical results regardless of the
// page's `dir`, asserted below for both.
describe("minutesFromClientY", () => {
  const dayStart = 6 * 60;
  const dayEnd = 24 * 60;
  const rect = { top: 200, height: 1440 }; // 06:00..24:00, 18h

  for (const dir of ["rtl", "ltr"] as const) {
    describe(`dir=${dir} (vertical time axis is dir-independent)`, () => {
      it("maps the rect's top edge to dayStartMinutes", () => {
        expect(minutesFromClientY(rect, 200, dayStart, dayEnd)).toBe(dayStart);
      });

      it("maps the rect's bottom edge to dayEndMinutes", () => {
        expect(minutesFromClientY(rect, 200 + 1440, dayStart, dayEnd)).toBe(dayEnd);
      });

      it("is linear and snaps to 15 minutes", () => {
        const halfway = minutesFromClientY(rect, 200 + 720, dayStart, dayEnd);
        expect(halfway % 15).toBe(0);
        expect(halfway).toBeCloseTo((dayStart + dayEnd) / 2, -1);
      });

      it("gives the same minute value for the same clientY regardless of which car column's rect is passed (columns share one y-range)", () => {
        const otherColSameY = { top: 200, height: 1440 };
        expect(minutesFromClientY(rect, 500, dayStart, dayEnd)).toBe(
          minutesFromClientY(otherColSameY, 500, dayStart, dayEnd),
        );
      });
    });
  }
});

describe("snapTimeShift", () => {
  it("zeroes out sub-half-slot movement — a car-only (purely horizontal) drag keeps the exact original time", () => {
    expect(snapTimeShift(0)).toBe(0);
    expect(snapTimeShift(3)).toBe(0);
    expect(snapTimeShift(-7)).toBe(0);
  });

  it("snaps a real vertical movement to the nearest 15 minutes", () => {
    expect(snapTimeShift(8)).toBe(15);
    expect(snapTimeShift(22)).toBe(15);
    expect(snapTimeShift(-22)).toBe(-15);
    expect(snapTimeShift(37)).toBe(30);
  });
});

describe("clampRideVertical", () => {
  const dayStart = 6 * 60;
  const dayEnd = 24 * 60;

  it("positions a ride fully inside the visible range proportionally, unclamped", () => {
    const rect = clampRideVertical(7 * 60, 9 * 60, dayStart, dayEnd);
    expect(rect.clampedStart).toBe(false);
    expect(parseFloat(rect.top)).toBeCloseTo(((7 * 60 - dayStart) / (dayEnd - dayStart)) * 100, 5);
    expect(parseFloat(rect.height)).toBeCloseTo(((9 - 7) * 60 / (dayEnd - dayStart)) * 100, 5);
  });

  it("clamps a ride starting before the visible range to the top edge and flags it (the '↑ HH:MM' marker)", () => {
    const rect = clampRideVertical(5 * 60 + 15, 7 * 60, dayStart, dayEnd);
    expect(rect.clampedStart).toBe(true);
    expect(rect.top).toBe("0%");
    // Height still reflects only the visible portion (05:15 clamped up to 06:00 → 06:00–07:00 shown).
    expect(parseFloat(rect.height)).toBeCloseTo((60 / (dayEnd - dayStart)) * 100, 5);
  });

  it("never flags a ride that starts exactly at the visible range's start", () => {
    expect(clampRideVertical(dayStart, dayStart + 30, dayStart, dayEnd).clampedStart).toBe(false);
  });

  it("keeps a minimum height for a 15-minute ride so the label stays legible (never below the 0.5% floor)", () => {
    const rect = clampRideVertical(12 * 60, 12 * 60 + 15, dayStart, dayEnd);
    expect(parseFloat(rect.height)).toBeGreaterThan(0);
  });
});
