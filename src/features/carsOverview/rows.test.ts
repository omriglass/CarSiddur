import { describe, expect, it } from "vitest";

import { buildCarOverviewRows, worstTire, type OverviewCar } from "./rows";

const car = (over: Partial<OverviewCar> & { id: string }): OverviewCar => ({
  name: over.id,
  license_plate: "11-111-11",
  status: "active",
  type: "shared",
  retired_at: null,
  codes: null,
  ...over,
});

describe("worstTire", () => {
  it("picks the worst position and ignores unchecked", () => {
    expect(worstTire({ a: "ok", b: "very_low", c: "low", d: "unchecked" })).toBe("very_low");
    expect(worstTire({ a: "ok", b: "low", c: "unchecked" })).toBe("low");
    expect(worstTire({ a: "unchecked", b: "ok" })).toBe("ok");
    expect(worstTire({ a: "unchecked" })).toBe("unchecked");
  });
  it("tolerates a missing or malformed payload", () => {
    expect(worstTire(null)).toBe("unchecked");
    expect(worstTire("x")).toBe("unchecked");
    expect(worstTire({ a: 3, b: "weird" })).toBe("unchecked");
  });
});

describe("buildCarOverviewRows", () => {
  it("excludes private and retired cars", () => {
    const rows = buildCarOverviewRows({
      cars: [
        car({ id: "a" }),
        car({ id: "priv", type: "temporary" }),
        car({ id: "ret", status: "retired" }),
        car({ id: "ret2", retired_at: "2026-01-01T00:00:00Z" }),
        car({ id: "maint", status: "maintenance" }),
      ],
      km: [],
      careEvents: [],
    });
    expect(rows.map((r) => r.id)).toEqual(["a", "maint"]);
  });

  it("flags replacement cars from either embed shape", () => {
    const rows = buildCarOverviewRows({
      cars: [car({ id: "a", codes: { is_replaced: true } }), car({ id: "b", codes: [{ is_replaced: true }] }), car({ id: "c", codes: [] }), car({ id: "d" })],
      km: [],
      careEvents: [],
    });
    expect(Object.fromEntries(rows.map((r) => [r.id, r.isReplacement]))).toEqual({ a: true, b: true, c: false, d: false });
  });

  it("takes the latest tyre fill and wash per car, and the current km", () => {
    const rows = buildCarOverviewRows({
      cars: [car({ id: "a" }), car({ id: "b" })],
      km: [{ car_id: "a", km: 120000, recorded_at: "2026-10-20T08:00:00Z" }],
      careEvents: [
        { car_id: "a", kind: "tire_fill", created_at: "2026-10-01T08:00:00Z", tires: { x: "very_low" } },
        { car_id: "a", kind: "tire_fill", created_at: "2026-10-10T08:00:00Z", tires: { x: "ok", y: "low" } },
        { car_id: "a", kind: "wash", created_at: "2026-10-05T08:00:00Z", tires: null },
      ],
      checklists: { a: { green: false, date: "2026-10-10", failed: ["lights"] } },
    });
    expect(rows[0]).toMatchObject({
      id: "a",
      km: { km: 120000, at: "2026-10-20T08:00:00Z" },
      tireFill: { at: "2026-10-10T08:00:00Z", worst: "low" },
      wash: { at: "2026-10-05T08:00:00Z" },
      checklist: { green: false },
    });
    expect(rows[1]).toMatchObject({ id: "b", km: null, tireFill: null, wash: null, checklist: null });
  });
});
