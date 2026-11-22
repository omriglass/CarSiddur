import { describe, expect, it } from "vitest";

import { tv } from "@/i18n/he";

import { chainBrokenWarningText } from "./chainWarning";

describe("chainBrokenWarningText (R5U6 / R22U5)", () => {
  const startsAt = "2026-12-01T08:00:00+02:00";
  it("names the ride by time and first names", () => {
    expect(chainBrokenWarningText({ starts_at: startsAt }, ["Dana Levi", " Omer "], "Haifa"))
      .toBe(tv("sadranBoard.carNotHereWarning", { ride: "08:00 · Dana · Omer", place: "Haifa" }));
  });
  it("a car move says it may be cancelled", () => {
    expect(chainBrokenWarningText({ starts_at: startsAt, pin_reason: "CAR_MOVE" }, [], "Haifa"))
      .toBe(tv("sadranBoard.carMoveNotHereWarning", { ride: "08:00", place: "Haifa" }));
  });
});
