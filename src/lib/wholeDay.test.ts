import { describe, expect, it } from "vitest";
import { isWholeDaySpan } from "@/lib/wholeDay";

describe("isWholeDaySpan (QB17)", () => {
  it("flags a midnight-to-end-of-day span", () => {
    expect(isWholeDaySpan("2026-10-11T21:00:00Z", "2026-10-12T20:59:00Z")).toBe(true);
    expect(isWholeDaySpan("2026-10-11T21:00:00Z", "2026-10-12T21:00:00Z")).toBe(true);
  });
  it("leaves real times alone", () => {
    expect(isWholeDaySpan("2026-10-12T06:00:00Z", "2026-10-12T10:00:00Z")).toBe(false);
    expect(isWholeDaySpan(null, "2026-10-12T10:00:00Z")).toBe(false);
  });
});
