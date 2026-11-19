// R20U9/R20U10 + CR1 (REQ item 257): the car's details for everyone — home base named, an empty code says so, a hidden
// code is left out; an editor changes one field in place and only that field is saved.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Car } from "@/features/admin/cars/api";
import { he, tv } from "@/i18n/he";

import { CarFactsCard } from "./CarFactsCard";

vi.mock("@/features/fleet/hooks", () => ({
  useDestinations: () => ({ data: [{ id: "x", name: "חדרה" }] }),
}));
const mutateAsync = vi.fn(async () => ({}));
vi.mock("../hooks", () => ({ useSaveCarFieldsMutation: () => ({ mutateAsync }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

const car = (patch: Partial<Car> = {}) => ({
  id: "c1", department_id: "d", base_location_id: null, access_code: null, is_replaced: false, replacement_code: null,
  responsible_id: null, features: [], built_in_child_seats: 0, built_in_boosters: 0, notes: null,
  tire_pressure_front_psi: null, tire_pressure_rear_psi: null, ...patch,
}) as unknown as Car;
const props = { canEdit: false, canEditResponsible: false, responsibleOptions: [], codeVisible: true };

describe("CarFactsCard", () => {
  it("a car based at home reads 'בית (ברירת מחדל)'; another base by name", () => {
    const { rerender } = render(<CarFactsCard car={car()} {...props} />);
    expect(screen.getByTestId("car-details-base").textContent).toContain(he.adminCars.fieldBaseLocationHome);
    rerender(<CarFactsCard car={car({ base_location_id: "x" })} {...props} />);
    expect(screen.getByTestId("car-details-base").textContent).toContain("חדרה");
  });

  it("an empty code reads 'לא הוגדר', a set one shows, a hidden one is absent; a viewer gets no pencil", () => {
    const { rerender } = render(<CarFactsCard car={car()} {...props} />);
    expect(screen.getByTestId("car-details-code").textContent).toContain(he.carPage.codeUnset);
    rerender(<CarFactsCard car={car({ access_code: "1234" })} {...props} />);
    expect(screen.getByTestId("car-details-code").textContent).toContain("1234");
    expect(screen.queryByTestId("car-details-code-edit")).toBeNull();
    rerender(<CarFactsCard car={car({ access_code: "1234" })} {...props} codeVisible={false} />);
    expect(screen.queryByTestId("car-details-code")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows the recommended tire pressure", () => {
    render(<CarFactsCard car={car({ tire_pressure_front_psi: 32, tire_pressure_rear_psi: 30 })} {...props} />);
    expect(screen.getByTestId("car-details-tires").textContent).toContain(tv("adminCars.tirePressureValue", { front: "32", rear: "30" }));
  });

  it("an editor saves the tire pressure in place, and nothing else", async () => {
    mutateAsync.mockClear();
    render(<CarFactsCard car={car({ access_code: "1234" })} {...props} canEdit />);
    fireEvent.click(screen.getByTestId("car-details-tires-edit"));
    fireEvent.change(screen.getByTestId("car-tire-front"), { target: { value: "32" } });
    fireEvent.change(screen.getByTestId("car-tire-rear"), { target: { value: "3" } });
    expect(screen.getByRole("alert").textContent).toBe(he.adminCars.tirePressureBoth);
    fireEvent.change(screen.getByTestId("car-tire-rear"), { target: { value: "30" } });
    fireEvent.click(screen.getByTestId("car-details-tires-save"));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ carId: "c1", patch: { tire_pressure_front_psi: 32, tire_pressure_rear_psi: 30 } }));
    await waitFor(() => expect(screen.getByTestId("car-details-tires").dataset.editing).toBeUndefined());
  });

  it("Escape cancels without saving", () => {
    mutateAsync.mockClear();
    render(<CarFactsCard car={car()} {...props} canEdit />);
    fireEvent.click(screen.getByTestId("car-details-code-edit"));
    const input = screen.getByTestId("car-details-code-input");
    fireEvent.change(input, { target: { value: "9999" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("car-details-code-input")).toBeNull();
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
