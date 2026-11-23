import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { he, tv } from "@/i18n/he";

import { CarGlance } from "./CarGlance";

const mocks = vi.hoisted(() => ({
  car: null as Record<string, unknown> | null,
  profiles: undefined as { id: string; full_name: string }[] | undefined,
}));

vi.mock("../hooks", () => ({
  useCarQuery: () => ({ data: mocks.car }),
  useCarCareHistoryQuery: () => ({ data: [] }),
}));
vi.mock("@/features/admin/members/hooks", () => ({
  useAllProfiles: () => ({ data: mocks.profiles }),
}));

describe("CarGlance", () => {
  beforeEach(() => {
    mocks.car = { id: "c1", type: "temporary", owner_id: "p1", owner_ids: ["p1"], responsible_id: null, license_plate: "12-345-67", fuel_type: null };
    mocks.profiles = undefined;
  });

  it("R20B11: an owned private car says loading, not 'no owner', until the names are in", () => {
    const { rerender } = render(<CarGlance carId="c1" />);
    expect(screen.getByText(he.carPage.glanceLoading)).toBeInTheDocument();
    expect(screen.queryByText(he.carPage.glanceNoOwner)).toBeNull();
    mocks.profiles = [{ id: "p1", full_name: "דנה" }];
    rerender(<CarGlance carId="c1" />);
    expect(screen.getByText(tv("carPage.glanceOwner", { name: "דנה" }))).toBeInTheDocument();
  });

  it("an ownerless private car says so without waiting for names", () => {
    mocks.car = { ...mocks.car, owner_id: null, owner_ids: [] };
    render(<CarGlance carId="c1" />);
    expect(screen.getByText(he.carPage.glanceNoOwner)).toBeInTheDocument();
  });

  it("a replaced car marks the plate and fuel as the replacement's", () => {
    mocks.car = { ...mocks.car, owner_id: null, owner_ids: [], fuel_type: "gasoline", is_replaced: true, replacement_plate: "7654321", replacement_fuel_type: "diesel" };
    render(<CarGlance carId="c1" />);
    const box = screen.getByTestId("car-glance-replacement");
    expect(box).toHaveTextContent(he.adminCars.replacedBadge);
    expect(box).toHaveTextContent("76-543-21");
    expect(box).toHaveTextContent(he.car.fuel.diesel);
    expect(box).not.toHaveTextContent(he.car.fuel.gasoline);
  });

  it("a regular car has no replacement mark", () => {
    mocks.car = { ...mocks.car, owner_id: null, owner_ids: [] };
    render(<CarGlance carId="c1" />);
    expect(screen.queryByTestId("car-glance-replacement")).toBeNull();
    expect(screen.queryByText(he.adminCars.replacedBadge)).toBeNull();
  });
});
