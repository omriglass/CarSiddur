import { describe, expect, it } from "vitest";

import { isTodayOrLater } from "./upcoming";

describe("isTodayOrLater", () => {
  const now = "2026-09-16T10:00:00+03:00"; // Wednesday, Asia/Jerusalem

  it("keeps a day later than today", () => {
    expect(isTodayOrLater("2026-09-17T08:00:00+03:00", now)).toBe(true);
  });

  it("keeps today itself, even earlier in the day than `now`", () => {
    expect(isTodayOrLater("2026-09-16T00:30:00+03:00", now)).toBe(true);
  });

  it("hides a day before today", () => {
    expect(isTodayOrLater("2026-09-15T23:59:00+03:00", now)).toBe(false);
  });

  it("compares in Asia/Jerusalem, not UTC — 22:30 UTC is already the next Jerusalem day", () => {
    // 2026-09-15T22:30:00Z is 2026-09-16T01:30 in Jerusalem (+3) — today, not yesterday.
    expect(isTodayOrLater("2026-09-15T22:30:00Z", "2026-09-16T00:00:00Z")).toBe(true);
  });
});
