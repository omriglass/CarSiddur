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

  it("includes named children alongside companions/guests instead of only counts", () => {
    const result = ridePublicDetails([{ companions: [{ profile_id: "m", name: "Adi Cohen" }], childNames: ["Noa Cohen"] }]);
    expect(result).toContain("Adi Cohen, Noa Cohen");
  });

  it("appends directly add_ride_passengers()-added names as a trailing line", () => {
    const result = ridePublicDetails([{ requester: "Adi", ride_description: "Gate" }], { addedNames: ["Guest One"] });
    expect(result).toContain("Gate");
    expect(result).toContain("Guest One");
  });

  it("omits the added-names line when includeCompanions is false", () => {
    const result = ridePublicDetails([{ ride_description: "Gate" }], { includeCompanions: false, addedNames: ["Guest One"] });
    expect(result).not.toContain("Guest One");
  });
});
