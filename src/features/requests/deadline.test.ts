import { describe, expect, it } from "vitest";

import { requestDeadlineText } from "./deadline";

describe("requestDeadlineText", () => {
  const week = { phase: "open", close_at: "2026-10-28T15:00:00Z" }; // Wed 28.10 17:00 Asia/Jerusalem (winter time)
  const before = Date.parse("2026-10-27T10:00:00Z");

  it("names the closing day and time while the week takes requests", () => {
    const text = requestDeadlineText(week, before);
    expect(text).toContain("28.10");
    expect(text).toContain("17:00");
  });

  it("says nothing after closing or outside the open phase", () => {
    expect(requestDeadlineText(week, Date.parse(week.close_at) + 1)).toBeNull();
    expect(requestDeadlineText({ ...week, phase: "solving" }, before)).toBeNull();
    expect(requestDeadlineText({ ...week, phase: "published" }, before)).toBeNull();
    expect(requestDeadlineText(null, before)).toBeNull();
  });
});
