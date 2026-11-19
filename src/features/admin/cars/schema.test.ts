import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";

import { carSchema } from "./schema";

const car = {
  name: "Car", license_plate: "1234567", fuel_type: null, department_id: "00000000-0000-0000-0000-000000000001",
  type: "shared", status: "active", features: [], notes: null, built_in_child_seats: 0, built_in_boosters: 0,
  access_code: "01234", is_replaced: false, replacement_code: null, responsible_id: null, base_location_id: null,
  corporation: null, tire_pressure_front_psi: null, tire_pressure_rear_psi: null,
};

describe("car access codes", () => {
  it("preserves leading zeros and requires four or five ASCII digits", () => {
    expect(carSchema.parse(car).access_code).toBe("01234");
    for (const access_code of ["123", "123456", "12ab", "١٢٣٤"]) {
      expect(carSchema.safeParse({ ...car, access_code }).success).toBe(false);
    }
  });

  it("asks for a department in Hebrew when none is chosen (R19B14)", () => {
    const result = carSchema.safeParse({ ...car, department_id: "" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(he.adminCars.departmentRequired);
  });

  it("requires a replacement code only while a replacement is active; it may equal the regular code", () => {
    expect(carSchema.safeParse({ ...car, is_replaced: true }).success).toBe(false);
    expect(carSchema.parse({ ...car, is_replaced: true, replacement_code: "01234" }).replacement_code).toBe("01234");
    expect(carSchema.parse({ ...car, is_replaced: true, replacement_code: "0567" }).replacement_code).toBe("0567");
    expect(carSchema.safeParse(car).success).toBe(true);
  });

  it("allows a car with no code, but not a replacement for it", () => {
    expect(carSchema.parse({ ...car, access_code: "" }).access_code).toBe("");
    expect(carSchema.safeParse({ ...car, access_code: "", is_replaced: true, replacement_code: "0567" }).success).toBe(false);
  });
});

describe("recommended tire pressure (CR1, REQ item 257)", () => {
  it("takes both or neither, 10-99 PSI", () => {
    expect(carSchema.safeParse({ ...car, tire_pressure_front_psi: 32, tire_pressure_rear_psi: 30 }).success).toBe(true);
    expect(carSchema.safeParse({ ...car, tire_pressure_front_psi: 32 }).success).toBe(false);
    expect(carSchema.safeParse({ ...car, tire_pressure_front_psi: 120, tire_pressure_rear_psi: 30 }).success).toBe(false);
  });
});
