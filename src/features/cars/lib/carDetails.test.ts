import { describe, expect, it } from "vitest";

import { he, tv } from "@/i18n/he";

import { seatConfigSummary, tirePressureError, tirePressureLabel } from "./carDetails";

describe("car details (CR1, REQ item 257)", () => {
  it("tire pressure: both empty or both 10-99", () => {
    expect(tirePressureError({ front: "", rear: "" })).toBeNull();
    expect(tirePressureError({ front: "32", rear: "30" })).toBeNull();
    expect(tirePressureError({ front: "32", rear: "" })).toBe(he.adminCars.tirePressureBoth);
    expect(tirePressureError({ front: "9", rear: "30" })).toBe(he.adminCars.tirePressureBoth);
    expect(tirePressureError({ front: "32.5", rear: "30" })).toBe(he.adminCars.tirePressureBoth);
  });
  it("tire pressure label", () => {
    expect(tirePressureLabel(null, null)).toBeNull();
    expect(tirePressureLabel(32, 30)).toBe(tv("adminCars.tirePressureValue", { front: "32", rear: "30" }));
  });
  it("seat configurations on one line, most adults first", () => {
    expect(seatConfigSummary([])).toBeNull();
    expect(seatConfigSummary([{ adults: 3, childSeats: 2, boosters: 0 }, { adults: 5, childSeats: 0, boosters: 0 }])).toBe(
      `5 ${he.adminCars.quickCheckAdults} · 3 ${he.adminCars.quickCheckAdults} + 2 ${he.adminCars.seatConfigColumnChildSeats}`,
    );
  });
});
