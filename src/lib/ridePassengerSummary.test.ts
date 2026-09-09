import { describe, expect, it } from "vitest";
import { ridePassengerSummary } from "./ridePassengerSummary";

describe("ride passenger summary", () => {
  it("falls back to an unnamed-child count when no child names are known", () => {
    const result = ridePassengerSummary([{ requester: "Adi", adults: 1, child_seats: 1, boosters: 0 }]);
    expect(result).toContain("Adi");
    expect(result).toContain("ילד/ה 1");
  });

  it("renders a known child's real name instead of the unnamed placeholder", () => {
    const result = ridePassengerSummary([{ requester: "Adi", adults: 1, child_seats: 1, boosters: 0, childNames: ["Noa"] }]);
    expect(result).toContain("Noa");
    expect(result).not.toContain("ילד/ה 1");
  });

  it("still reports unnamed children for any seats beyond the known names", () => {
    const result = ridePassengerSummary([{ requester: "Adi", adults: 1, child_seats: 2, boosters: 0, childNames: ["Noa"] }]);
    expect(result).toContain("Noa");
    expect(result).toContain("ילד/ה 1");
  });
});
