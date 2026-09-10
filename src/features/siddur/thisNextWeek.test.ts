import { describe, expect, it } from "vitest";

import { resolveThisNextWeek } from "./thisNextWeek";

describe("resolveThisNextWeek", () => {
  // 2026-09-10 is a Thursday; the Jerusalem week containing it starts Sunday 2026-09-06.
  const today = "2026-09-10";

  it("computes this/next week starts from today alone, independent of the weeks list", () => {
    const { thisWeekStart, nextWeekStart } = resolveThisNextWeek([], today);
    expect(thisWeekStart).toBe("2026-09-06");
    expect(nextWeekStart).toBe("2026-09-13");
  });

  it("returns the matching week when it is visible", () => {
    const weeks = [
      { week_start: "2026-09-06", phase: "live" as const },
      { week_start: "2026-09-13", phase: "open" as const },
    ];
    const result = resolveThisNextWeek(weeks, today);
    expect(result.thisWeek).toEqual(weeks[0]);
    expect(result.nextWeek).toEqual(weeks[1]);
  });

  it("returns null (not undefined-crash) for a week missing from the RLS-filtered list", () => {
    const weeks = [{ week_start: "2026-09-06", phase: "live" as const }];
    const result = resolveThisNextWeek(weeks, today);
    expect(result.thisWeek).toEqual(weeks[0]);
    expect(result.nextWeek).toBeNull();
  });

  it("still returns real date labels for both weeks even when neither is visible", () => {
    const result = resolveThisNextWeek([], today);
    expect(result.thisWeek).toBeNull();
    expect(result.nextWeek).toBeNull();
    expect(result.thisWeekStart).toBe("2026-09-06");
    expect(result.nextWeekStart).toBe("2026-09-13");
  });

  it("handles a Sunday today (already the week start) without drifting", () => {
    const result = resolveThisNextWeek([], "2026-09-06");
    expect(result.thisWeekStart).toBe("2026-09-06");
    expect(result.nextWeekStart).toBe("2026-09-13");
  });
});
