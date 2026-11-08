import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import { DayEntries, RideDriverPicker } from "./RideDriverPicker";

const mutate = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock("../../hooks", () => ({ useSetRideDriverMutation: () => ({ mutate, mutateAsync: mutate, isPending: false }) }));

const base = {
  rideId: "ride-1", version: 3, candidates: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
  departmentId: "dept", weekStart: "2026-10-11",
};

beforeEach(() => mutate.mockReset());

describe("RideDriverPicker (R8U1: replace a volunteer in one step)", () => {
  it("a ride that needs a driver offers the assign picker only", () => {
    render(<RideDriverPicker {...base} needsDriver volunteerName={null} />);
    expect(screen.getByText(he.rideDriver.assignLabel)).toBeInTheDocument();
    fireEvent.click(screen.getAllByTestId("ride-driver-option")[0]!);
    expect(screen.getByTestId("ride-driver-assign")).toHaveTextContent(he.rideDriver.assign);
    expect(screen.queryByTestId("ride-driver-unassign")).not.toBeInTheDocument();
  });

  it("a ride with a volunteer shows the volunteer, a remove button AND a replace picker", () => {
    render(<RideDriverPicker {...base} needsDriver={false} volunteerName="V" volunteerId="v" />);
    expect(screen.getByText(/V/)).toBeInTheDocument();
    expect(screen.getByText(he.rideDriver.replaceLabel)).toBeInTheDocument();
    expect(screen.getByTestId("ride-driver-list")).toBeInTheDocument();
    expect(screen.queryByTestId("ride-driver-assign")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByTestId("ride-driver-option")[0]!);
    expect(screen.getByTestId("ride-driver-assign")).toHaveTextContent(he.rideDriver.replace);
    fireEvent.click(screen.getByTestId("ride-driver-unassign"));
    expect(mutate).toHaveBeenCalledWith({ rideId: "ride-1", driverId: null, expectedVersion: 3, departmentId: "dept", weekStart: "2026-10-11" }, expect.anything());
  });

  it("renders nothing when the ride has a driver of its own request", () => {
    const { container } = render(<RideDriverPicker {...base} needsDriver={false} volunteerName={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("RideDriverPicker type-ahead list", () => {
  const candidates = [{ id: "a", name: "Avi" }, { id: "b", name: "Bina" }, { id: "c", name: "Chen" }];
  const props = { ...base, candidates, needsDriver: true, volunteerName: null };
  const optionIds = () => screen.getAllByTestId("ride-driver-option").map((el) => el.getAttribute("data-driver-id"));

  it("typing filters the list at once, with no dropdown to open", () => {
    render(<RideDriverPicker {...props} />);
    expect(optionIds()).toEqual(["a", "b", "c"]);
    fireEvent.change(screen.getByTestId("ride-driver-search"), { target: { value: "bi" } });
    expect(optionIds()).toEqual(["b"]);
    fireEvent.change(screen.getByTestId("ride-driver-search"), { target: { value: "zzz" } });
    expect(screen.getByTestId("ride-driver-no-match")).toBeInTheDocument();
  });

  it("lists free people first and marks busy ones", () => {
    render(<RideDriverPicker {...props} busyIds={new Set(["a"])} />);
    expect(optionIds()).toEqual(["b", "c", "a"]);
    expect(screen.getAllByTestId("ride-driver-option")[2]).toHaveTextContent(he.rideDriver.busy);
  });

  it("selecting a row shows its assign button, which assigns", () => {
    render(<RideDriverPicker {...props} />);
    const row = screen.getAllByTestId("ride-driver-option")[1]!;
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(row).getByTestId("ride-driver-assign"));
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ rideId: "ride-1", driverId: "b", expectedVersion: 3 }), expect.anything());
  });

  it("arrows move the selection and Enter assigns it", () => {
    render(<RideDriverPicker {...props} />);
    const search = screen.getByTestId("ride-driver-search");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getAllByTestId("ride-driver-option")[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(search, { key: "ArrowUp" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ driverId: "a" }), expect.anything());
  });
});

describe("DayEntries (R13F2: what the chosen driver already has that day)", () => {
  const entries = [
    { kind: "drives" as const, startsAt: "2026-10-12T06:00:00Z", endsAt: "2026-10-12T08:00:00Z", destination: "Haifa", overlaps: true },
    { kind: "request" as const, startsAt: "2026-10-12T12:00:00Z", endsAt: "2026-10-12T13:00:00Z", destination: null, overlaps: false },
  ];

  it("lists each entry with its kind and marks only the overlapping one", () => {
    render(<DayEntries name="A" entries={entries} />);
    const rows = screen.getAllByTestId("ride-driver-day-entry");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(he.rideDriver.dayKind.drives);
    expect(rows[0]).toHaveTextContent("Haifa");
    expect(rows[0]).toHaveTextContent(he.rideDriver.dayOverlap);
    expect(rows[1]).toHaveTextContent(he.rideDriver.dayKind.request);
    expect(rows[1]).not.toHaveTextContent(he.rideDriver.dayOverlap);
    expect(within(screen.getByTestId("ride-driver-day")).queryByText(he.rideDriver.dayNone)).not.toBeInTheDocument();
  });

  it("says so when the person has nothing else that day", () => {
    render(<DayEntries name="B" entries={[]} />);
    expect(screen.getByText(he.rideDriver.dayNone)).toBeInTheDocument();
    expect(screen.queryByTestId("ride-driver-day-entry")).not.toBeInTheDocument();
  });
});
