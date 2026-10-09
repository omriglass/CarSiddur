import { describe, expect, it } from "vitest";

import { carMood, daysSince } from "./carMood";

const now = new Date("2026-10-09T12:00:00+03:00");

describe("carMood", () => {
  it("never washed", () => {
    expect(carMood(null, now)).toBe("never");
    expect(carMood(undefined, now)).toBe("never");
  });
  it("happy under 7 days", () => {
    expect(carMood("2026-10-09T08:00:00+03:00", now)).toBe("happy");
    expect(carMood("2026-10-03T00:30:00+03:00", now)).toBe("happy");
  });
  it("ok from 7 to 20 days", () => {
    expect(carMood("2026-10-02T23:00:00+03:00", now)).toBe("ok");
    expect(carMood("2026-09-19T10:00:00+03:00", now)).toBe("ok");
  });
  it("sad from 21 days", () => {
    expect(carMood("2026-09-18T10:00:00+03:00", now)).toBe("sad");
  });
  it("counts days in Asia/Jerusalem, not UTC", () => {
    // 22:30 UTC on 8 Oct is 01:30 on 9 Oct in Jerusalem
    expect(daysSince("2026-10-08T22:30:00Z", now)).toBe(0);
  });
});
