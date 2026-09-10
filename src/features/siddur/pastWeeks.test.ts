import { describe, expect, it } from "vitest";

import { isPastWeek, pastWeeks } from "./pastWeeks";

describe("isPastWeek", () => {
  // 2026-09-10 is a Thursday; the Jerusalem week containing it starts Sunday 2026-09-06.
  const today = "2026-09-10";

  it("is past when week_start precedes this week's Sunday, regardless of phase", () => {
    expect(isPastWeek({ week_start: "2026-08-30", phase: "published" }, today)).toBe(true);
    expect(isPastWeek({ week_start: "2026-08-30", phase: "live" }, today)).toBe(true);
  });

  it("is not past for this week or a future week even if somehow marked archived", () => {
    expect(isPastWeek({ week_start: "2026-09-06", phase: "live" }, today)).toBe(false);
    expect(isPastWeek({ week_start: "2026-09-13", phase: "open" }, today)).toBe(false);
  });

  it("is past whenever the phase is archived, even for this week's own Sunday key", () => {
    expect(isPastWeek({ week_start: "2026-09-06", phase: "archived" }, today)).toBe(true);
  });

  it("treats a Sunday today as the boundary (last week is past, this week is not)", () => {
    expect(isPastWeek({ week_start: "2026-08-30", phase: "live" }, "2026-09-06")).toBe(true);
    expect(isPastWeek({ week_start: "2026-09-06", phase: "live" }, "2026-09-06")).toBe(false);
  });
});

describe("pastWeeks", () => {
  const today = "2026-09-10";

  it("keeps only past weeks, sorted newest first", () => {
    const weeks = [
      { week_start: "2026-08-16", phase: "archived" as const },
      { week_start: "2026-08-30", phase: "archived" as const },
      { week_start: "2026-09-06", phase: "live" as const },
      { week_start: "2026-09-13", phase: "open" as const },
    ];
    expect(pastWeeks(weeks, today).map((w) => w.week_start)).toEqual(["2026-08-30", "2026-08-16"]);
  });

  it("returns an empty list when there is nothing past yet", () => {
    const weeks = [{ week_start: "2026-09-06", phase: "live" as const }];
    expect(pastWeeks(weeks, today)).toEqual([]);
  });
});
