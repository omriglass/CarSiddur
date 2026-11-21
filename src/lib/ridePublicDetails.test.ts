import { describe, expect, it } from "vitest";
import { tv } from "@/i18n/he";

import { ridePublicDetailLines, ridePublicDetails, rideDescriptionLines } from "./ridePublicDetails";

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

  it("keeps each merged request's text after its requester's name; one line of other riders for the whole ride, last", () => {
    // owner 2026-11-16: "עומרי: …" on one line; RP1 (owner 2026-11-21): one "נוסעים" line at the bottom with everyone on
    // the ride - the requesters and the driver too, every kind of rider, unnamed seats last
    const entries = [{ requester: "Adi", role: "driver" as const, ride_description: "Gate", guest_passenger_names: ["Dan"], adults: 3 }, { requester: "Ben", guest_passenger_names: ["Visitor"] }];
    expect(ridePublicDetails(entries, { addedNames: ["Gil"] }).split("\n")).toEqual(["Adi: Gate", tv("ridePublicDetails.peopleLine", { names: "Adi, Dan, Ben, Visitor, Gil, מבוגר/ת 1" })]);
    // a volunteer driver with no request of their own is listed first
    expect(ridePublicDetails([{ requester: "Ben" }], { driverName: "Tal" })).toBe(tv("ridePublicDetails.peopleLine", { names: "Tal, Ben" }));
    expect(ridePublicDetails([{}])).toBe("");
  });

  it("picks out the names: the requester before the colon and each other rider", () => {
    const lines = ridePublicDetailLines([{ requester: "Adi", ride_description: "Gate" }, { requester: "Ben", guest_passenger_names: ["Visitor", "Dan"] }]);
    expect(lines[0]).toEqual([{ text: "Adi:", emphasis: true }, { text: " Gate" }]);
    expect(lines[1]?.filter((segment) => segment.emphasis).map((segment) => segment.text)).toEqual(["Adi", "Ben", "Visitor", "Dan"]);
    expect(rideDescriptionLines("Own note", [{ ride_description: "Gate" }])?.map((line) => line.map((segment) => segment.text).join(""))).toEqual(["Own note", "Gate"]);
    expect(rideDescriptionLines(null, [])).toBeUndefined();
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

describe("ride public details by leg (RP1)", () => {
  it("lists everyone as one line per leg when someone rides one way only", () => {
    const entries = [
      { requester: "Yael", leg: "both" as const, companions: [{ profile_id: "p1", name: "Inbar" }] },
      { requester: "Noga", leg: "return" as const, guest_passenger_names: ["Dana"] },
    ];
    expect(ridePublicDetails(entries)).toBe("הלוך: Yael, Inbar\nחזור: Yael, Inbar, Noga, Dana");
    expect(ridePublicDetails([{ requester: "Yael", leg: "both" as const, companions: [{ profile_id: "p1", name: "Inbar" }] }])).toBe("נוסעים: Yael, Inbar");
  });
});
