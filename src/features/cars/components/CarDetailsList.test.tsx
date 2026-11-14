// R20U9/R20U10: the read-only car details — home base named, an empty code says so, a hidden code is left out.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Car } from "@/features/admin/cars/api";
import { he } from "@/i18n/he";

import { CarDetailsList } from "./CarDetailsList";

vi.mock("@/features/fleet/hooks", () => ({
  useDestinations: () => ({ data: [{ id: "x", name: "חדרה" }] }),
}));

const car = (patch: Partial<Car> = {}) => ({
  id: "c1", department_id: "d", base_location_id: null, access_code: null, is_replaced: false, replacement_code: null,
  responsible_id: null, features: [], built_in_child_seats: 0, built_in_boosters: 0, notes: null, ...patch,
}) as unknown as Car;

describe("CarDetailsList", () => {
  it("a car based at home reads 'בית (ברירת מחדל)'; another base by name", () => {
    const { rerender } = render(<CarDetailsList car={car()} responsibleName={null} codeVisible />);
    expect(screen.getByTestId("car-details-base").textContent).toContain(he.adminCars.fieldBaseLocationHome);
    rerender(<CarDetailsList car={car({ base_location_id: "x" })} responsibleName={null} codeVisible />);
    expect(screen.getByTestId("car-details-base").textContent).toContain("חדרה");
  });

  it("an empty code reads 'לא הוגדר', a set one shows, a hidden one is absent", () => {
    const { rerender } = render(<CarDetailsList car={car()} responsibleName={null} codeVisible />);
    expect(screen.getByTestId("car-details-code").textContent).toContain(he.carPage.codeUnset);
    rerender(<CarDetailsList car={car({ access_code: "1234" })} responsibleName={null} codeVisible />);
    expect(screen.getByTestId("car-details-code").textContent).toContain("1234");
    rerender(<CarDetailsList car={car({ access_code: "1234" })} responsibleName={null} codeVisible={false} />);
    expect(screen.queryByTestId("car-details-code")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
