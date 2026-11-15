import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import { RequestForm } from "./RequestForm";

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  layout: { current: "sentence" as "sentence" | "classic" },
  routeMinutes: { current: 45 as number | undefined },
  members: { current: [{ id: "dana", name: "Dana" }] as { id: string; name: string }[] },
}));

vi.mock("../hooks", () => ({
  useSubmitRequestMutation: () => ({ mutateAsync: mocks.submit, isPending: false }),
  useSubmitSeriesRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useMyRequests: () => ({ data: [] }),
  useRequestFormLayout: () => mocks.layout.current,
  useRouteMinutesFetcher: () => () => Promise.resolve(45),
  useRouteMinutesQuery: (_dept: string | undefined, _points: unknown, enabled: boolean) => ({
    data: enabled ? mocks.routeMinutes.current : undefined,
    isError: false,
  }),
  useRequestCompanionsQuery: () => ({ data: [], isSuccess: true }),
  useRequestChildrenQuery: () => ({ data: [], isSuccess: true }),
  useRecentCompanionsQuery: () => ({ data: [] }),
  useSetRequestCompanionsMutation: () => ({ mutateAsync: vi.fn() }),
  useSetRequestChildrenMutation: () => ({ mutateAsync: vi.fn() }),
  useSaveRequestTemplateMutation: () => ({ mutateAsync: vi.fn() }),
  useStopTemplateMutation: () => ({ mutateAsync: vi.fn() }),
  useJoinableRidesMutation: () => ({ mutateAsync: vi.fn().mockResolvedValue([]) }),
  useWithdrawRequestMutation: () => ({ mutateAsync: vi.fn() }),
  useCancelRideMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/features/auth/useDepartmentMembers", () => ({ useDepartmentMembers: () => ({ data: mocks.members.current }) }));
vi.mock("@/features/auth/useSession", () => ({ useSession: () => ({ session: null }) }));
vi.mock("@/features/fleet/hooks", () => ({
  useDestinations: () => ({ data: [
    { id: "destination", name: "Destination", aliases: [], zone: "", travel_minutes: 30, is_drop_point: false },
    { id: "harish", name: "Harish", aliases: [], zone: "", travel_minutes: 20, is_drop_point: true },
  ] }),
  useRideTypes: () => ({ data: [{ id: "type", code: "other", name_he: "other-type" }] }),
  useCars: () => ({ data: [] }),
  useCarSeatConfigs: () => ({ data: [] }),
  useMyTemporaryCars: () => ({ data: [] }),
  useSuggestDestinationMutation: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/features/sadran/hooks", () => ({
  useDepartmentSettings: () => ({ data: { chauffeur_dwell_minutes: 10 } }),
  useWeekRow: () => ({ data: { settings_overrides: {} } }),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn() }) }));
// The classic layout's combobox is its own tested component; a one-button stand-in picks the
// destination there (the sentence layout's sheets use the inline `PlacePicker`).
vi.mock("@/components/DestinationCombobox", () => ({
  DestinationCombobox: ({ onChange }: { onChange: (value: { presetId: string; name: string }) => void }) => (
    <button type="button" onClick={() => onChange({ presetId: "destination", name: "Destination" })}>pick-destination</button>
  ),
}));
vi.mock("@/components/CompanionPicker", () => ({ CompanionPicker: () => null }));

function show() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <RequestForm mode="new" departmentId="department" weekStart="2044-01-03" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function pickSentenceDestination() {
  fireEvent.click(screen.getByTestId("chip-destination"));
  fireEvent.click(screen.getByText("Destination"));
}

beforeEach(() => {
  mocks.submit.mockReset();
  mocks.submit.mockResolvedValue({ request_id: "request", status: "submitted" });
  mocks.layout.current = "sentence";
  mocks.routeMinutes.current = 45;
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});

async function submitFromStageOne() {
  fireEvent.click(screen.getByTestId("stage-next"));
  await waitFor(() => expect(screen.getByTestId("stage-two")).toBeVisible());
  fireEvent.click(screen.getByRole("button", { name: he.action.submitRequest }));
}

describe("RequestForm: the answers of one save travel together (R21B7)", () => {
  const guests = [{ request_id: "guest", name: "Noa", kind: "cannot", warnings: [], reason: "day", added_minutes: 0, wanted_at: "2044-01-04T06:00:00Z", ride_at: "2044-01-04T13:00:00Z" }];

  it("a later question keeps the earlier answers: overlap yes, then the guest, then the car staying away", async () => {
    mocks.submit
      // the overlap question was asked and answered yes inside the first call, which then stopped at the guest question
      .mockResolvedValueOnce({ ok: false, needs_confirmation: "host_guests", host_guests: guests, overlap_confirmed: true })
      .mockResolvedValueOnce({ ok: false, needs_confirmation: "car_stays_away", car_name: "Car", next_ride: true })
      .mockResolvedValueOnce({ request_id: "request", status: "assigned" });
    show();
    pickSentenceDestination();
    await submitFromStageOne();
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit.mock.calls[0]![0]).not.toHaveProperty("overlap_confirmed");

    fireEvent.click(await screen.findByRole("button", { name: he.request.hostGuestSaveAnyway }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(2));
    expect(mocks.submit.mock.calls[1]![0]).toMatchObject({ overlap_confirmed: true, host_guests: { guest: "release" } });

    fireEvent.click(await screen.findByRole("button", { name: he.request.carStaysAwayConfirmNew }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(3));
    expect(mocks.submit.mock.calls[2]![0]).toMatchObject({ overlap_confirmed: true, host_guests: { guest: "release" }, allow_car_away: true });
  });

  it("back on a late question, then the same save again: the overlap is not asked again, the choice is", async () => {
    mocks.submit
      .mockResolvedValueOnce({ ok: false, needs_confirmation: "host_guests", host_guests: guests, overlap_confirmed: true })
      .mockResolvedValueOnce({ ok: false, needs_confirmation: "host_guests", host_guests: guests });
    show();
    pickSentenceDestination();
    await submitFromStageOne();
    fireEvent.click(await screen.findByRole("button", { name: he.request.hostGuestBack }));
    await waitFor(() => expect(screen.queryByRole("button", { name: he.request.hostGuestSaveAnyway })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: he.action.submitRequest }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(2));
    expect(mocks.submit.mock.calls[1]![0]).toMatchObject({ overlap_confirmed: true });
    expect(mocks.submit.mock.calls[1]![0]).not.toHaveProperty("host_guests");
    expect(await screen.findByRole("button", { name: he.request.hostGuestSaveAnyway })).toBeVisible();
  });
});
