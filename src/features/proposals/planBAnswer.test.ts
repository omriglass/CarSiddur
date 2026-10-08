import { describe, expect, it } from "vitest";

import { planBLines } from "./planBAnswer";

const t = (hhmm: string) => new Date(`2026-10-13T${hhmm}:00.000Z`).toISOString();
const request = { id: "r", destination: "חיפה", rideType: null, departAt: t("05:00"), returnAt: t("14:00"), adults: 1, childSeats: 0, boosters: 0, tripType: "round_trip" };

describe("planBLines", () => {
  it("states the car, the leave/arrive times, the pickup car and what it replaces", () => {
    const lines = planBLines({ dropPlace: "צומת חריש", arriveBy: t("06:00"), pickupAt: t("15:00"), carName: "ואן", departAt: t("05:15"), originName: "נבו", pickupCarName: "ואן", returnAt: t("15:45") }, request);
    expect(lines.car).toContain("ואן");
    expect(lines.leave).toMatch(/מנבו/);
    expect(lines.leave).toMatch(/צומת חריש/);
    expect(lines.pickup).toMatch(/איסוף ב/);
    expect(lines.pickup).toMatch(/ברכב ואן/);
    expect(lines.otherCar).toBeNull();
    expect(lines.back).not.toBeNull();
    expect(lines.replaces).toMatch(/במקום: הלוך-חזור לחיפה/);
  });
  it("flags another pickup car, a pickup from another place, and handles a one-way with no pickup", () => {
    const other = planBLines({ dropPlace: "צומת חריש", arriveBy: t("06:00"), pickupAt: t("15:00"), pickupPlace: "פרדס", carName: "ואן", pickupCarName: "מיני", departAt: t("05:15") }, request);
    expect(other.otherCar).toMatch(/רכב אחר/);
    expect(other.pickup).toMatch(/איסוף מפרדס/);
    const oneWay = planBLines({ dropPlace: "צומת חריש", arriveBy: t("06:00"), pickupAt: null, carName: "ואן", departAt: t("05:15") }, { ...request, tripType: "one_way", returnAt: null });
    expect(oneWay.pickup).toBeNull();
    expect(oneWay.replaces).toMatch(/הלוך בלבד לחיפה/);
  });
  it("is null-safe for an older summary without the new fields", () => {
    const lines = planBLines({ dropPlace: "צומת חריש", arriveBy: t("06:00"), pickupAt: null }, null);
    expect(lines).toEqual({ car: null, leave: null, pickup: null, otherCar: null, back: null, replaces: null });
  });
});
