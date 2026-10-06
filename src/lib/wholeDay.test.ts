import { describe, expect, it } from "vitest";
import { isWholeDaySpan, rideSpanKind } from "@/lib/wholeDay";

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

describe("rideSpanKind (R5B11)", () => {
  const at = (hhmm: string) => `2026-10-12T${hhmm}:00+03:00`;
  it("middle day of a series is all day", () => expect(rideSpanKind(at("00:00"), at("23:59"))).toBe("all_day"));
  it("first day shows the departure only", () => expect(rideSpanKind(at("08:00"), at("23:59"))).toBe("departure_only"));
  it("last day shows the return only", () => expect(rideSpanKind(at("00:00"), at("17:30"))).toBe("return_only"));
  it("an ordinary ride is a range", () => expect(rideSpanKind(at("08:00"), at("17:30"))).toBe("range"));
});
