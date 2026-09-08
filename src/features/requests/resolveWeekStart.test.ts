import { describe, expect, it } from "vitest";
import { resolveWeekStart } from "./resolveWeekStart";

const now = new Date("2026-09-08T10:00:00+03:00");
const weeks = [
  { week_start: "2026-08-30", phase: "solving" },
  { week_start: "2026-09-06", phase: "solving" },
  { week_start: "2026-09-13", phase: "open" },
] as const;
describe("new request week selection", () => {
  it("prefers the open week after catch-up", () => {
    expect(resolveWeekStart(weeks, undefined, now)).toBe("2026-09-13");
  });
  it("allows requests in the recovered current solving week", () => {
    expect(resolveWeekStart(weeks.slice(0, 2), undefined, now)).toBe("2026-09-06");
    expect(resolveWeekStart(weeks, "2026-09-06", now)).toBe("2026-09-06");
  });
  it("does not select stale or archived weeks", () => {
    expect(resolveWeekStart([weeks[0]], undefined, now)).toBeUndefined();
    expect(resolveWeekStart([{ ...weeks[1], phase: "archived" }], "2026-09-06", now)).toBeUndefined();
  });
});
