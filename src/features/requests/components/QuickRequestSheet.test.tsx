import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { he, tv } from "@/i18n/he";
import { QuickRequestSheet } from "./QuickRequestSheet";

const mocks = vi.hoisted(() => ({ submit: vi.fn(), setCompanions: vi.fn(), setChildren: vi.fn(), success: vi.fn() }));
vi.mock("../hooks", () => ({
  useSubmitRequestMutation: () => ({ mutateAsync: mocks.submit, isPending: false }),
  useMyRequests: () => ({ data: [] }),
  useRequestCompanionsQuery: () => ({ data: [], isSuccess: true }),
  useRequestChildrenQuery: () => ({ data: [], isSuccess: true }),
  useSetRequestCompanionsMutation: () => ({ mutateAsync: mocks.setCompanions }),
  useSetRequestChildrenMutation: () => ({ mutateAsync: mocks.setChildren }),
  useSaveRequestTemplateMutation: () => ({ mutateAsync: vi.fn() }),
  useStopTemplateMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/features/auth/useDepartmentMembers", () => ({ useDepartmentMembers: () => ({ data: [{ id: "member", name: "Member" }] }) }));
vi.mock("@/features/auth/useSession", () => ({ useSession: () => ({ session: null }) }));
vi.mock("@/features/fleet/hooks", () => ({
  useDestinations: () => ({ data: [{ id: "destination", travel_minutes: 30 }] }),
  useRideTypes: () => ({ data: [{ id: "type", code: "other", name_he: "אחר" }] }),
  useCars: () => ({ data: [] }),
  useCarSeatConfigs: () => ({ data: [] }),
  useSuggestDestinationMutation: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/features/sadran/hooks", () => ({ useDepartmentSettings: () => ({ data: { chauffeur_dwell_minutes: 10 } }), useWeekRow: () => ({ data: { settings_overrides: {} } }) }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: mocks.success }) }));
// `type="button"` matters on both mocks below: RequestForm now wraps everything in a real
// `<form>` (previously QuickRequestSheet's own submit button called `handleSubmit()` manually
// from a plain `<div>`), and an un-typed `<button>` inside a form defaults to `type="submit"`
// — omitting it here would make clicking these mocked controls submit the form prematurely.
vi.mock("@/components/DestinationCombobox", () => ({ DestinationCombobox: ({ onChange }: { onChange: (value: { presetId: string; name: string }) => void }) => <button type="button" onClick={() => onChange({ presetId: "destination", name: "Destination" })}>Destination</button> }));
// Distinguishes the companions picker (no `label` prop, RequestForm.tsx) from the children
// picker (`label={t('field.children')}`) so both can render at once without an ambiguous query.
vi.mock("@/components/CompanionPicker", () => ({ CompanionPicker: ({ onChange, label }: { onChange: (value: string[]) => void; label?: string }) => <button type="button" onClick={() => onChange(["member"])}>{label ?? "Member"}</button> }));

function show(initialStartTime = "12:00") {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter>
    <QuickRequestSheet open onOpenChange={vi.fn()} departmentId="department" weekStart="2044-01-03" day="2044-01-03" initialStartTime={initialStartTime} initialCarId="car" cars={[{ id: "car", name: "Car", type: "shared" }]} freeWindows={[{ carId: "car", start: 0, end: Infinity }]} now={new Date("2044-01-03T00:00:00Z")} />
  </MemoryRouter></QueryClientProvider>);
}
beforeEach(() => { mocks.submit.mockReset(); mocks.setCompanions.mockReset(); mocks.setChildren.mockReset(); mocks.success.mockReset(); });

describe("quick request sheet (RequestForm's variant=\"quick\")", () => {
  it("caps a late round trip at 23:59 instead of creating an overnight request", async () => {
    mocks.submit.mockResolvedValue({ status: "assigned", car_id: "car" });
    show("23:45");
    fireEvent.click(screen.getByRole("button", { name: "Destination" }));
    fireEvent.click(screen.getByRole("button", { name: he.quickRequest.submit }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    expect(mocks.submit.mock.calls[0]![0]).toMatchObject({ depart_at: "2044-01-03T21:45:00.000Z", return_at: "2044-01-03T21:59:00.000Z" });
  });

  it("blocks a late one-way request whose driver could only return the following day", () => {
    show("23:45");
    fireEvent.click(screen.getByRole("button", { name: "Destination" }));
    fireEvent.click(screen.getByRole("radio", { name: he.request.tripShapeOneWayTo }));
    expect(screen.getByText(he.sadranProposal.sameDayOnly)).toBeVisible();
    expect(screen.getByRole("button", { name: he.quickRequest.submitOneWay })).toBeDisabled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it.each(["one_way_to", "one_way_from"] as const)("submits %s as an atomic public passenger request with a missing-driver reservation", async (shape) => {
    mocks.submit.mockResolvedValue({ request_id: "request", status: "waitlisted", needs_driver: true, ride_id: "ride", car_id: "car" });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Destination" }));
    fireEvent.click(screen.getByRole("radio", { name: shape === "one_way_to" ? he.request.tripShapeOneWayTo : he.request.tripShapeOneWayFrom }));
    fireEvent.change(screen.getByLabelText(he.quickRequest.rideDescription), { target: { value: "Public route and pickup" } });
    fireEvent.click(screen.getByRole("button", { name: "Member" }));
    fireEvent.change(screen.getByLabelText(he.quickRequest.guestPassengers), { target: { value: " Guest \n" } });
    fireEvent.click(screen.getByRole("button", { name: he.quickRequest.submitOneWay }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    const payload = mocks.submit.mock.calls[0]![0];
    expect(payload).toMatchObject({ trip_shape: shape, one_way_car_mode: "passenger", reserve_missing_driver: true, ride_description: "Public route and pickup", guest_passenger_names: ["Guest"], adults: 3 });
    expect(payload.notes).toBeUndefined();
    expect(payload[shape === "one_way_to" ? "depart_at" : "return_at"]).toBe("2044-01-03T10:00:00.000Z");
    expect(payload[shape === "one_way_to" ? "return_at" : "depart_at"]).toBeUndefined();
    // Companions are set through the same follow-up RPC the weekly form uses, not inline.
    expect(mocks.setCompanions).toHaveBeenCalledWith({ requestId: "request", profileIds: ["member"] });
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith(tv("quickRequest.successNeedsDriver", { car: "Car" })));
  });

  it("preserves the round-trip keep request and its two-hour default", async () => {
    mocks.submit.mockResolvedValue({ status: "assigned", car_id: "car" });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Destination" }));
    fireEvent.click(screen.getByRole("button", { name: he.quickRequest.submit }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    expect(mocks.submit.mock.calls[0]![0]).toMatchObject({ trip_shape: "round_trip", needs_car_at_destination: true, depart_at: "2044-01-03T10:00:00.000Z", return_at: "2044-01-03T12:00:00.000Z", adults: 1 });
    expect(mocks.submit.mock.calls[0]![0].reserve_missing_driver).toBeUndefined();
  });
});
