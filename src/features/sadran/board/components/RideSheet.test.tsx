import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { he, tv } from "@/i18n/he";

import type { BoardRide } from "../../api";

import { RideSheet } from "./RideSheet";

vi.mock("@/features/rides/components/RidePublicNotesEditor", () => ({ RidePublicNotesEditor: () => <div data-testid="stub-notes" /> }));
vi.mock("@/features/rides/components/RidePassengersList", () => ({ RidePassengersList: () => <div data-testid="stub-passengers-list" /> }));
vi.mock("@/features/rides/components/AddPassengersDialog", () => ({ AddPassengersDialog: () => <div data-testid="stub-add-passengers" /> }));
vi.mock("@/features/rides/components/RidePersonBlocks", () => ({ RidePersonBlocks: () => <div /> }));
vi.mock("@/features/rides/components/RideRoute", () => ({ RideRoute: () => <div /> }));
vi.mock("@/features/rides/components/RideRouteStops", () => ({ RideRouteStops: () => <div data-testid="stub-route-stops" /> }));
vi.mock("./RideRouteEditor", () => ({ RideRouteEditor: () => <div /> }));
vi.mock("./RidePassengersEditor", () => ({ RidePassengersEditor: () => <div /> }));
vi.mock("./TripTypeChange", () => ({ TripTypeChange: () => <div data-testid="stub-trip-type" /> }));
vi.mock("./PlanSwitchButton", () => ({ PlanSwitchButton: () => <div /> }));
vi.mock("./WithdrawDuplicateAction", () => ({ WithdrawDuplicateAction: () => <button type="button" data-testid="withdraw-duplicate" /> }));
vi.mock("./RideDriverPicker", () => ({ RideDriverPicker: () => <div data-testid="stub-driver-picker" /> }));
vi.mock("./RideCancelDialog", () => ({ RideCancelDialog: () => null }));
const succeed = (_vars: unknown, options?: { onSuccess?: () => void }) => options?.onSuccess?.();
const removePassenger = vi.fn(succeed);
const splitCompanion = vi.fn(succeed);
vi.mock("@/features/rides/hooks", () => ({ useRemoveRidePassengerMutation: () => ({ mutate: removePassenger, isPending: false }) }));
vi.mock("../../hooks", () => ({ useSplitRideCompanionMutation: () => ({ mutate: splitCompanion, isPending: false }) }));

const ride = {
  id: "r1", version: 1, status: "confirmed", car_id: "c1", starts_at: "2044-01-04T05:00:00Z", ends_at: "2044-01-04T09:00:00Z",
  origin_id: "home", destination_id: "d1", origin_name: "Home", destination_name: "Binyamina", needs_driver: false, driver_id: "u1", driver_name: "Noga",
  served: [{ request_id: "q1", role: "driver", leg: "both", car_mode: "keep", adults: 1, child_seats: 0, boosters: 0, luggage: false, requester: "Noga",
    destination: "Binyamina", origin_id: "home", trip_type: "round_trip", child_names: ["Yoav"] }],
  people: [],
} as unknown as BoardRide;

const request = { id: "q1", version: 1, depart_at: "2044-01-04T05:00:00Z", return_at: "2044-01-04T09:00:00Z", requester_full_name: "Noga" };

function renderSheet(theRide: BoardRide = ride, onRemoveAddedPerson?: (requestId: string, name: string) => void) {
  return render(
    <RideSheet ride={theRide} onRemoveAddedPerson={onRemoveAddedPerson} cars={[]} driverName="Noga" homeDestinationId="home" onOpenChange={vi.fn()} onSave={vi.fn()} onTogglePin={vi.fn()} onCancel={vi.fn()}
      requests={[request] as never} departmentId="dept" weekStart="2044-01-02" driverCandidates={[]} />,
  );
}

describe("RideSheet tabs (REQ §13.201)", () => {
  it("opens on the summary: one line per request, no repeated passenger line, no other tabs' content", () => {
    renderSheet();
    const line = screen.getByTestId("ride-sheet-summary-line");
    expect(line).toHaveTextContent("Noga");
    expect(line).toHaveTextContent("Binyamina");
    expect(line).toHaveTextContent("07:00");
    expect(line.className).not.toMatch(/muted/);
    expect(screen.getAllByText(/Noga/)).toHaveLength(1);
    expect(screen.getByTestId("ride-car-select")).toBeInTheDocument();
    expect(screen.queryByTestId("stub-driver-picker")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ride-sheet-cancel")).not.toBeInTheDocument();
  });

  it("each tab shows its own part", () => {
    const open = (id: string) => fireEvent.mouseDown(screen.getByTestId(`ride-sheet-tab-${id}`), { button: 0, ctrlKey: false });
    renderSheet();
    open("people");
    expect(screen.getByTestId("stub-driver-picker")).toBeInTheDocument();
    expect(screen.getByTestId("stub-add-passengers")).toBeInTheDocument();
    open("route");
    expect(screen.getByTestId("stub-route-stops")).toBeInTheDocument();
    open("actions");
    expect(screen.getByTestId("ride-sheet-cancel")).toBeInTheDocument();
    expect(screen.getByTestId("withdraw-duplicate")).toBeInTheDocument();
  });

  it("a ride without merged guests has no \"נסיעות מאוחדות\" tab", () => {
    renderSheet();
    expect(screen.queryByTestId("ride-sheet-tab-merged")).not.toBeInTheDocument();
  });

  it("a merged ride gets \"נסיעות מאוחדות\" between סיכום and אנשים, holding the remove button (owner 2026-11-09)", () => {
    const guest = { ...(ride.served as unknown as Record<string, unknown>[])[0], request_id: "q2", role: "passenger", requester: "Gil", child_names: [] };
    const mergedRide = { ...ride, served: [...(ride.served as unknown as unknown[]), guest] } as unknown as BoardRide;
    const remove = vi.fn();
    renderSheet(mergedRide, remove);
    const tabs = screen.getAllByRole("tab").map((tab) => tab.getAttribute("data-testid"));
    expect(tabs.slice(0, 3)).toEqual(["ride-sheet-tab-summary", "ride-sheet-tab-merged", "ride-sheet-tab-people"]);
    fireEvent.mouseDown(screen.getByTestId("ride-sheet-tab-merged"), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("button", { name: tv("mergedRide.removeAria", { name: "Gil" }) }));
    expect(remove).toHaveBeenCalledWith("q2", "Gil");
    fireEvent.mouseDown(screen.getByTestId("ride-sheet-tab-people"), { button: 0, ctrlKey: false });
    expect(screen.queryByTestId("ride-added-people")).not.toBeInTheDocument();
  });

  it("a passenger on a merged ride asks how to leave: only x, x with the guest, or x alone (owner 2026-11-09)", () => {
    const base = (ride.served as unknown as Record<string, unknown>[])[0]!;
    const guest = { ...base, request_id: "q2", role: "passenger", requester: "Gil", child_names: [], companions: [{ profile_id: "x", name: "Xena" }] };
    const host = { ...base, companions: [{ profile_id: "y", name: "Yael" }] };
    const mergedRide = { ...ride, served: [host, guest] } as unknown as BoardRide;
    const splitGuest = vi.fn();
    render(
      <RideSheet ride={mergedRide} onRemoveAddedPerson={vi.fn()} onSplitGuest={splitGuest} cars={[]} driverName="Noga" homeDestinationId="home" onOpenChange={vi.fn()} onSave={vi.fn()}
        onTogglePin={vi.fn()} onCancel={vi.fn()} requests={[request] as never} departmentId="dept" weekStart="2044-01-02" driverCandidates={[]} />,
    );
    fireEvent.mouseDown(screen.getByTestId("ride-sheet-tab-merged"), { button: 0, ctrlKey: false });
    expect(screen.getAllByTestId("ride-merged-passenger").map((chip) => chip.textContent)).toEqual([
      expect.stringContaining(tv("mergedRide.passengerWith", { name: "Yael", owner: "Noga" })),
      expect.stringContaining(tv("mergedRide.passengerWith", { name: "Xena", owner: "Gil" })),
    ]);

    // the host's passenger: no "x and the host" option
    fireEvent.click(screen.getByRole("button", { name: tv("mergedRide.passengerAria", { name: "Yael" }) }));
    expect(screen.getByTestId("merged-passenger-removeOnly")).toBeInTheDocument();
    expect(screen.queryByTestId("merged-passenger-withOwner")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.mergedRide.splitConfirm }));
    expect(removePassenger).toHaveBeenCalledWith(expect.objectContaining({ rideId: "r1", key: "comp:q1:y" }), expect.anything());

    // the guest's passenger: all three; "alone" splits x into a request of their own
    fireEvent.click(screen.getByRole("button", { name: tv("mergedRide.passengerAria", { name: "Xena" }) }));
    expect(screen.getByTestId("merged-passenger-withOwner")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("merged-passenger-alone"));
    fireEvent.click(screen.getByRole("button", { name: he.mergedRide.splitConfirm }));
    expect(splitCompanion).toHaveBeenCalledWith(expect.objectContaining({ rideId: "r1", requestId: "q2", profileId: "x", expectedVersion: 1 }), expect.anything());
  });
});
