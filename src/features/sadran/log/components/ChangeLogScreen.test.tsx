import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";
import { ChangeLogScreen } from "./ChangeLogScreen";

const at = (hhmm: string) => `2040-01-02T${hhmm}:00Z`;
const request = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, status: "assigned", trip_shape: "round_trip", trip_type: "round_trip", requester_full_name: name,
  original_depart_at: at("08:00"), depart_at: at("08:00"), original_return_at: at("10:00"), return_at: at("10:00"),
  flex_depart_early: "00:15:00", flex_depart_late: "00:15:00", flex_return_early: "00:15:00", flex_return_late: "00:15:00",
  origin_resolved_name: "A", destination_resolved_name: "B", companions: [], childNames: [], stops: [], status_reason: null, ...extra,
});
const ride = (id: string, requestId: string, starts: string, ends: string) => ({
  id, status: "confirmed", car_id: "c1", starts_at: starts, ends_at: ends, driver_name: "D", is_chauffeur: false, route: [], people: [],
  served: [{ request_id: requestId, role: "driver", leg: "both", car_mode: "keep", requester: "x" }],
});

const mocks = vi.hoisted(() => ({ requests: [] as unknown[], rides: [] as unknown[], proposals: [] as unknown[], audit: [] as unknown[] }));
vi.mock("../../hooks", () => ({
  useWeekRequestsWithNames: () => ({ data: mocks.requests, isLoading: false, isError: false }),
  useAllWeekRides: () => ({ data: mocks.rides, isLoading: false, isError: false }),
  useProposalsForWeek: () => ({ data: mocks.proposals, isLoading: false, isError: false }),
  useCarsForDepartment: () => ({ data: [], isLoading: false, isError: false }),
  useAuditLog: () => ({ data: mocks.audit, isLoading: false, isError: false }),
  useRestoreClosedRequestMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/features/siddur/hooks", () => ({ useDepartments: () => ({ data: [] }) }));
vi.mock("@/features/fleet/hooks", () => ({ useDestinations: () => ({ data: [] }) }));

function show() {
  return render(<MemoryRouter><ChangeLogScreen departmentId="d" weekStart="2040-01-01" /></MemoryRouter>);
}

describe("ChangeLogScreen", () => {
  it("lists only requests moved beyond their flexibility by default, and all differences when the switch is off", () => {
    mocks.requests = [request("q1", "Moved"), request("q2", "Inside"), request("q3", "Same")];
    mocks.rides = [ride("r1", "q1", at("08:30"), at("10:30")), ride("r2", "q2", at("08:15"), at("10:00")), ride("r3", "q3", at("08:00"), at("10:00"))];
    mocks.proposals = [{ id: "p1", request_id: "q1", status: "applied", updated_at: "" }];
    const { container } = show();
    expect(container.querySelectorAll('[data-change-log-request="q1"]').length).toBeGreaterThan(0);
    expect(container.querySelector('[data-change-log-request="q2"]')).toBeNull();
    expect(container.querySelector('[data-change-log-request="q3"]')).toBeNull();
    expect(screen.getAllByText(he.rideDelta.agreed).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("switch"));
    expect(container.querySelector('[data-change-log-request="q2"]')).not.toBeNull();
    expect(container.querySelector('[data-change-log-request="q3"]')).toBeNull();
  });

  it("shows an unplaced request with its reason and filters by name", () => {
    mocks.requests = [request("q1", "Alice", { status: "denied", status_reason: "NO_CAR" }), request("q2", "Bob", { status: "denied" })];
    mocks.rides = [];
    mocks.proposals = [];
    const { container } = show();
    expect(container.querySelector('[data-change-log-request="q1"]')).not.toBeNull();
    fireEvent.change(screen.getByLabelText(he.sadranLog.searchPlaceholder), { target: { value: "bob" } });
    expect(container.querySelector('[data-change-log-request="q1"]')).toBeNull();
    expect(container.querySelector('[data-change-log-request="q2"]')).not.toBeNull();
  });

  it("shows a request the Sadran closed with its reason and the return button; an ordinary cancellation has none (REQ §13.162)", () => {
    mocks.requests = [
      request("q1", "Closed", { status: "cancelled", status_reason: "CLOSED_BY_SADRAN", version: 3 }),
      request("q2", "Cancelled", { status: "cancelled", status_reason: "RIDE_CANCELLED", version: 2 }),
    ];
    mocks.rides = [];
    mocks.proposals = [];
    mocks.audit = [{ id: 1, at: at("09:00"), table_name: "requests", row_id: "q1", action: "update", reason: "got a lift",
      before: { status: "waitlisted", status_reason: null }, after: { status: "cancelled", status_reason: "CLOSED_BY_SADRAN" }, changed_columns: ["status", "status_reason"], actor_role: "sadran" }];
    const { container } = show();
    const closedRows = container.querySelectorAll('[data-change-log-request="q1"]');
    expect(closedRows.length).toBeGreaterThan(0);
    expect(container.querySelector('[data-change-log-request="q1"] [data-testid="change-log-restore"]')).not.toBeNull();
    expect(container.querySelector('[data-change-log-request="q1"]')?.textContent).toContain("got a lift");
    expect(container.querySelector('[data-change-log-request="q2"] [data-testid="change-log-restore"]')).toBeNull();
    mocks.audit = [];
  });
});
