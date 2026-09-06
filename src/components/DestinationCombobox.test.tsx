import { describe, expect, it } from "vitest";

import { filterDestinations, type DestinationPreset } from "./DestinationCombobox";

const DESTINATIONS: DestinationPreset[] = [
  { id: "1", name: "עפולה", aliases: ["מרפאת כללית"], zone: "north" },
  { id: "2", name: "חיפה", aliases: [], zone: "haifa" },
  { id: "3", name: "תל אביב", aliases: ["ת\"א"], zone: "tel_aviv" },
];

describe("filterDestinations", () => {
  it("returns everything for an empty query", () => {
    expect(filterDestinations(DESTINATIONS, "")).toHaveLength(3);
  });

  it("matches by name", () => {
    expect(filterDestinations(DESTINATIONS, "עפולה").map((d) => d.id)).toEqual(["1"]);
  });

  it("matches by alias", () => {
    expect(filterDestinations(DESTINATIONS, "מרפאת").map((d) => d.id)).toEqual(["1"]);
  });

  it("matches by zone", () => {
    expect(filterDestinations(DESTINATIONS, "haifa").map((d) => d.id)).toEqual(["2"]);
  });

  it("is case-insensitive for latin zones", () => {
    expect(filterDestinations(DESTINATIONS, "HAIFA").map((d) => d.id)).toEqual(["2"]);
  });

  it("returns no presets for an unmatched query (free text still offered by the component)", () => {
    expect(filterDestinations(DESTINATIONS, "משהו שלא קיים")).toHaveLength(0);
  });
});
