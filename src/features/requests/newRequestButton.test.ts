import { describe, expect, it } from "vitest";

import { newRequestButtonState } from "./newRequestButton";

describe("newRequestButtonState", () => {
  it("state 1: an open next week alongside the live week -> nextWeek", () => {
    const weeks = [
      { week_start: "2026-09-06", phase: "live" },
      { week_start: "2026-09-13", phase: "open" },
    ];
    expect(newRequestButtonState(weeks)).toEqual({ kind: "nextWeek", weekStart: "2026-09-13" });
  });

  it("state 2: a solving next week -> disabled preparing", () => {
    const weeks = [
      { week_start: "2026-09-06", phase: "live" },
      { week_start: "2026-09-13", phase: "solving" },
    ];
    expect(newRequestButtonState(weeks)).toEqual({ kind: "preparing" });
  });

  it("state 3: a published next week -> waitlistNextWeek", () => {
    const weeks = [
      { week_start: "2026-09-06", phase: "live" },
      { week_start: "2026-09-13", phase: "published" },
    ];
    expect(newRequestButtonState(weeks)).toEqual({ kind: "waitlistNextWeek", weekStart: "2026-09-13" });
  });

  it("state 4 (edge): only a live week exists, nothing newer yet -> disabled nextWeekNotOpenYet (never 'this week')", () => {
    const weeks = [{ week_start: "2026-09-06", phase: "live" }];
    expect(newRequestButtonState(weeks)).toEqual({ kind: "nextWeekNotOpenYet" });
  });

  it("an `upcoming` next week (materialized early for a multi-day series) is not a real target — falls back to nextWeekNotOpenYet", () => {
    const weeks = [
      { week_start: "2026-09-06", phase: "live" },
      { week_start: "2026-09-20", phase: "upcoming" },
    ];
    expect(newRequestButtonState(weeks)).toEqual({ kind: "nextWeekNotOpenYet" });
  });

  it("ignores archived weeks entirely", () => {
    const weeks = [
      { week_start: "2026-08-30", phase: "archived" },
      { week_start: "2026-09-06", phase: "live" },
    ];
    expect(newRequestButtonState(weeks)).toEqual({ kind: "nextWeekNotOpenYet" });
  });

  it("no weeks at all -> preparing (nothing to link to)", () => {
    expect(newRequestButtonState([])).toEqual({ kind: "preparing" });
  });

  it("picks the newest non-live week when more than one is eligible", () => {
    const weeks = [
      { week_start: "2026-09-06", phase: "live" },
      { week_start: "2026-09-13", phase: "published" },
      { week_start: "2026-09-20", phase: "open" },
    ];
    expect(newRequestButtonState(weeks)).toEqual({ kind: "nextWeek", weekStart: "2026-09-20" });
  });
});
