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

  it("R22B6: a named child in an adult seat is not an extra unnamed adult", () => {
    const result = ridePassengerSummary([{ requester: "Adi", adults: 2, child_seats: 0, boosters: 0, childNames: ["Noa"] }]);
    expect(result).toContain("Noa");
    expect(result).not.toContain("מבוגר/ת 1");
    expect(result).not.toContain("ילד/ה 1");
  });

  it("lists directly add_ride_passengers()-added names alongside request-derived ones", () => {
    const result = ridePassengerSummary([{ requester: "Adi", adults: 1, child_seats: 0, boosters: 0 }], null, { addedNames: ["Guest One"] });
    expect(result).toContain("Adi");
    expect(result).toContain("Guest One");
  });

  it("drops blank added names", () => {
    const result = ridePassengerSummary([], null, { addedNames: ["  ", "Guest One"] });
    expect(result).not.toContain("  ");
    expect(result).toContain("Guest One");
  });

  it("splits the people by leg when someone rides one way on a ride that carries both directions, nobody on a one-leg ride (RP1)", () => {
    const host = { request_id: "h", role: "driver" as const, leg: "both" as const, requester: "Yael", adults: 1, child_seats: 0, boosters: 0 };
    const out = { request_id: "o", role: "passenger" as const, leg: "out" as const, requester: "Noga", adults: 1, child_seats: 0, boosters: 0 };
    const back = { request_id: "b", role: "passenger" as const, leg: "return" as const, requester: "Maayan", adults: 1, child_seats: 0, boosters: 0 };
    expect(ridePassengerSummary([host, out, back])).toBe("הלוך: Yael וNoga\nחזור: Yael וMaayan");
    expect(ridePassengerSummary([out])).toBe("נוסעים: Noga");
    expect(ridePassengerSummary([{ ...out, requester: "Noga" }, { ...back, request_id: "b2" }])).toBe("הלוך: Noga\nחזור: Maayan");
    expect(ridePassengerSummary([host, { ...out, adults: 2 }])).toBe("הלוך: Yael, Noga ומבוגר/ת 1\nחזור: Yael");
    expect(ridePassengerSummary([host], null, { addedNames: [{ name: "Dana", leg: "return" }] })).toBe("הלוך: Yael\nחזור: Yael וDana");
    expect(ridePassengerSummary([host], null, { addedNames: [{ name: "Dana", leg: "both" }] })).toBe("נוסעים: Yael וDana");
  });
});
