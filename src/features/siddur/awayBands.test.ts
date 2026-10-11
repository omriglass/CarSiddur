import { describe, expect, it } from "vitest";

import { awayBandBlocks } from "./awayBands";

const label = (place: string) => `at ${place}`;
// 2026-10-13 is a Tuesday; Israel is UTC+3 in October.
const row = { car_id: "car", away_from: "2026-10-13T07:00:00Z", away_until: "2026-10-13T13:30:00Z", location_name: "חיפה" };

describe("awayBandBlocks (owner 2026-10-11: the siddur shows where a car is left)", () => {
  it("draws the stay between the one-way's arrival and the car's next ride, labelled with the place", () => {
    expect(awayBandBlocks([row], "2026-10-13", label)).toEqual([
      { id: "away:car:0", carId: "car", startMinutes: 600, endMinutes: 990, kind: "away", label: "at חיפה" },
    ]);
  });
  it("clips a stay crossing midnight to the shown day; an open-ended stay runs to midnight", () => {
    const overnight = { ...row, away_until: "2026-10-14T05:00:00Z" };
    expect(awayBandBlocks([overnight], "2026-10-13", label)[0]).toMatchObject({ startMinutes: 600, endMinutes: 1440 });
    expect(awayBandBlocks([overnight], "2026-10-14", label)[0]).toMatchObject({ startMinutes: 0, endMinutes: 480 });
    expect(awayBandBlocks([{ ...row, away_until: null }], "2026-10-15", label)[0]).toMatchObject({ startMinutes: 0, endMinutes: 1440 });
  });
  it("draws nothing on other days or for incomplete rows", () => {
    expect(awayBandBlocks([row], "2026-10-12", label)).toEqual([]);
    expect(awayBandBlocks([row], "2026-10-14", label)).toEqual([]);
    expect(awayBandBlocks([{ ...row, car_id: null }], "2026-10-13", label)).toEqual([]);
  });
});
