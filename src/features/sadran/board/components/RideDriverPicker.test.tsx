import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import { RideDriverPicker } from "./RideDriverPicker";

const mutate = vi.fn();
vi.mock("../../hooks", () => ({ useSetRideDriverMutation: () => ({ mutate, isPending: false }) }));

const base = {
  rideId: "ride-1", version: 3, candidates: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
  departmentId: "dept", weekStart: "2026-10-11",
};

beforeEach(() => mutate.mockReset());

describe("RideDriverPicker (R8U1: replace a volunteer in one step)", () => {
  it("a ride that needs a driver offers the assign picker only", () => {
    render(<RideDriverPicker {...base} needsDriver volunteerName={null} />);
    expect(screen.getByText(he.rideDriver.assignLabel)).toBeInTheDocument();
    expect(screen.getByTestId("ride-driver-assign")).toHaveTextContent(he.rideDriver.assign);
    expect(screen.queryByTestId("ride-driver-unassign")).not.toBeInTheDocument();
  });

  it("a ride with a volunteer shows the volunteer, a remove button AND a replace picker", () => {
    render(<RideDriverPicker {...base} needsDriver={false} volunteerName="V" volunteerId="v" />);
    expect(screen.getByText(/V/)).toBeInTheDocument();
    expect(screen.getByText(he.rideDriver.replaceLabel)).toBeInTheDocument();
    expect(screen.getByTestId("ride-driver-select")).toBeInTheDocument();
    expect(screen.getByTestId("ride-driver-assign")).toHaveTextContent(he.rideDriver.replace);
    expect(screen.getByTestId("ride-driver-assign")).toBeDisabled();
    fireEvent.click(screen.getByTestId("ride-driver-unassign"));
    expect(mutate).toHaveBeenCalledWith({ rideId: "ride-1", driverId: null, expectedVersion: 3, departmentId: "dept", weekStart: "2026-10-11" }, expect.anything());
  });

  it("renders nothing when the ride has a driver of its own request", () => {
    const { container } = render(<RideDriverPicker {...base} needsDriver={false} volunteerName={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
