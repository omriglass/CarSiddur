import { describe, expect, it } from "vitest";

import { he, tv } from "@/i18n/he";

import { countLabel } from "./summary";

describe("countLabel (R15B3)", () => {
  it("uses the Hebrew singular for one", () => {
    expect(countLabel("reservations", 1)).toBe(he.planning.countReservationsOne);
    expect(countLabel("rides", 1)).toBe(he.planning.countRidesOne);
    expect(countLabel("requests", 1)).toBe(he.planning.countRequestsOne);
  });

  it("uses the plural with the number otherwise", () => {
    expect(countLabel("reservations", 3)).toBe(tv("planning.countReservations", { n: "3" }));
    expect(countLabel("rides", 0)).toBe(tv("planning.countRides", { n: "0" }));
  });
});
