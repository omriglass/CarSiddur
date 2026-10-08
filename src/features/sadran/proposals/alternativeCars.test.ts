import { describe, expect, it } from "vitest";

import { alternativeLegWindows, carsFreeForWindow } from "./alternativeCars";

const t = (hhmm: string) => new Date(`2026-10-13T${hhmm}:00.000Z`).toISOString();
const ms = (hhmm: string) => Date.parse(t(hhmm));

describe("alternativeLegWindows", () => {
  it("drop-off: from the departure to the arrival plus the same drive back", () => {
    const { out, pickup } = alternativeLegWindows({ departAt: t("05:00"), arriveBy: t("06:00"), pickupAt: null, returnAt: null });
    expect(out).toEqual({ startMs: ms("05:00"), endMs: ms("07:00") });
    expect(pickup).toBeNull();
  });
  it("pickup from the drop-off place ends when the member is back; pickup from elsewhere ends one drive after the pickup", () => {
    const home = alternativeLegWindows({ departAt: t("05:00"), arriveBy: t("06:00"), pickupAt: t("15:00"), returnAt: t("16:15") });
    expect(home.pickup).toEqual({ startMs: ms("14:00"), endMs: ms("16:15") });
    const elsewhere = alternativeLegWindows({ departAt: t("05:00"), arriveBy: t("06:00"), pickupAt: t("15:00"), returnAt: null });
    expect(elsewhere.pickup).toEqual({ startMs: ms("14:00"), endMs: ms("16:00") });
  });
});

describe("carsFreeForWindow", () => {
  const cars = [
    { id: "b", name: "ב", status: "active", type: "shared" },
    { id: "a", name: "א", status: "active", type: "shared" },
    { id: "t", name: "זמני", status: "active", type: "temporary" },
    { id: "m", name: "בתיקון", status: "maintenance", type: "shared" },
  ];
  const win = { startMs: ms("05:00"), endMs: ms("07:00") };
  it("drops busy, temporary and inactive cars, keeps the chosen one, sorts by name", () => {
    const rides = [{ car_id: "a", starts_at: t("06:00"), ends_at: t("08:00"), status: "confirmed" }, { car_id: "b", starts_at: t("06:00"), ends_at: t("08:00"), status: "cancelled" }];
    expect(carsFreeForWindow(cars, rides, win, null).map((c) => c.id)).toEqual(["b"]);
    expect(carsFreeForWindow(cars, rides, win, "a").map((c) => c.id)).toEqual(["a", "b"]);
    expect(carsFreeForWindow(cars, rides, win, "t").map((c) => c.id)).toEqual(["b", "t"]);
  });
  it("a ride that only touches the window does not make a car busy", () => {
    const rides = [{ car_id: "a", starts_at: t("07:00"), ends_at: t("09:00"), status: "confirmed" }];
    expect(carsFreeForWindow(cars, rides, win, null).map((c) => c.id)).toEqual(["a", "b"]);
  });
});
