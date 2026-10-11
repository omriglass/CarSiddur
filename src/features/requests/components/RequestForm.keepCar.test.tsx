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

describe("RequestForm keep-car line (REQ §13.126 g)", () => {
  it("offers the link on a driver's single-day round trip; on shows the line next to plan B; × turns it off", () => {
    show();
    expect(screen.getByTestId("keep-car-link")).toBeVisible();
    expect(screen.getByTestId("plan-b-link")).toBeVisible();
    fireEvent.click(screen.getByTestId("keep-car-link"));
    expect(screen.getByTestId("keep-car-line")).toHaveTextContent(he.keepCar.placeEmpty);
    expect(screen.getByTestId("plan-b-link")).toBeVisible();
    fireEvent.click(screen.getByTestId("keep-car-remove"));
    expect(screen.getByTestId("keep-car-link")).toBeVisible();
    expect(screen.getByTestId("plan-b-link")).toBeVisible();
  });

  it("names the destination in the line", () => {
    show();
    pickSentenceDestination();
    fireEvent.click(screen.getByTestId("keep-car-link"));
    expect(screen.getByTestId("keep-car-line")).toHaveTextContent("Destination");
  });

  it("is not offered on a הקפצה", () => {
    show();
    fireEvent.click(screen.getByTestId("chip-trip"));
    fireEvent.click(screen.getByRole("radio", { name: he.request.tripTypeDropOff }));
    fireEvent.click(screen.getByTestId("drop-off-switch-place"));
    fireEvent.click(screen.getByText("Harish"));
    fireEvent.click(screen.getByRole("button", { name: he.planB.switch.confirm }));
    fireEvent.click(screen.getByRole("button", { name: he.requestSentence.sheetDone }));
    expect(screen.queryByTestId("keep-car-link")).not.toBeInTheDocument();
  });

  it("submits a two-way הקפצה with the flag and plan B together, and the recap shows both", async () => {
    show();
    pickSentenceDestination();
    fireEvent.click(screen.getByTestId("keep-car-link"));
    fireEvent.click(screen.getByTestId("plan-b-link"));
    fireEvent.click(screen.getByTestId("chip-plan-b-kind"));
    fireEvent.click(screen.getByTestId("plan-b-option-manage"));
    fireEvent.click(screen.getByTestId("stage-next"));
    await waitFor(() => expect(screen.getByTestId("stage-two")).toBeVisible());
    expect(screen.getByTestId("recap-keep-car")).toHaveTextContent("Destination");
    expect(screen.getByTestId("recap-plan-b")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: he.action.submitRequest }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    const payload = mocks.submit.mock.calls[0]![0];
    expect(payload).toMatchObject({ trip_type: "drop_off", keep_car_at_destination: true, trip_shape: "round_trip" });
    expect(payload.return_at).toBeDefined();
    expect(payload.fallback).toBe("manage");
  });

  it("off: no keep_car_at_destination key, trip_type stays round_trip", async () => {
    show();
    pickSentenceDestination();
    await submitFromStageOne();
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    const payload = mocks.submit.mock.calls[0]![0];
    expect(payload.trip_type).toBe("round_trip");
    expect(payload).not.toHaveProperty("keep_car_at_destination");
  });
});
