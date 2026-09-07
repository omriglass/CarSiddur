import { describe, expect, it } from "vitest";
import { ridePublicDetails } from "./ridePublicDetails";

describe("public ride details", () => {
  it("shows public text and both member and guest names without coordinator notes", () => {
    const entry = { ride_description: "Meet by the gate", notes: "Private coordinator note",
      companions: [{ profile_id: "member", name: "Adi Cohen" }], guest_passenger_names: ["Guest Smith", "Guest Smith"] };
    const result = ridePublicDetails([entry]);
    expect(result).toContain("Meet by the gate");
    expect(result).toContain("Adi Cohen, Guest Smith");
    // Two guests can share a name; each still represents a passenger.
    expect(result.match(/Guest Smith/g)).toHaveLength(2);
    expect(result).not.toContain(entry.notes);
  });

  it("keeps each merged request's text attached to its requester", () => {
    expect(ridePublicDetails([{ requester: "Adi", ride_description: "Gate" }, { requester: "Ben", guest_passenger_names: ["Visitor"] }]))
      .toMatch(/Adi:\nGate\nBen:\n.*Visitor/);
    expect(ridePublicDetails([{}])).toBe("");
  });
});
