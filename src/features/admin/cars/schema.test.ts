import { describe, expect, it } from "vitest";

import { carSchema } from "./schema";

const car = {
  name: "Car", license_plate: "1234567", department_id: "00000000-0000-0000-0000-000000000001",
  type: "shared", status: "active", features: [], notes: null, built_in_child_seats: 0, built_in_boosters: 0,
  access_code: "01234", is_replaced: false, replacement_code: null, responsible_id: null,
};

describe("car access codes", () => {
  it("preserves leading zeros and requires four or five ASCII digits", () => {
    expect(carSchema.parse(car).access_code).toBe("01234");
    for (const access_code of ["", "123", "123456", "12ab", "١٢٣٤"]) {
      expect(carSchema.safeParse({ ...car, access_code }).success).toBe(false);
    }
  });

  it("requires a distinct replacement code only while a replacement is active", () => {
    expect(carSchema.safeParse({ ...car, is_replaced: true }).success).toBe(false);
    expect(carSchema.safeParse({ ...car, is_replaced: true, replacement_code: "01234" }).success).toBe(false);
    expect(carSchema.parse({ ...car, is_replaced: true, replacement_code: "0567" }).replacement_code).toBe("0567");
    expect(carSchema.safeParse(car).success).toBe(true);
  });
});
