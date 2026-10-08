import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

describe("RequestForm plan B line (REQ §13.112 a/b)", () => {
  it("offers the link on a round trip, hides it for a הקפצה", () => {
    show();
    expect(screen.getByTestId("plan-b-link")).toBeVisible();
    fireEvent.click(screen.getByTestId("chip-trip"));
    fireEvent.click(screen.getByRole("radio", { name: he.request.tripTypeDropOff }));
    fireEvent.click(screen.getByRole("button", { name: he.requestSentence.sheetDone }));
    expect(screen.queryByTestId("plan-b")).not.toBeInTheDocument();
  });

  it("an empty plan B blocks the next stage; with a drop point picked the payload carries it", async () => {
    show();
    pickSentenceDestination();
    fireEvent.click(screen.getByTestId("plan-b-link"));
    expect(screen.getByTestId("plan-b-line")).toBeVisible();
    // Defaults: arrive by departure 08:00 + 1 h, pickup at the main return 12:00.
    expect(screen.getByTestId("chip-plan-b-arrive")).toHaveTextContent("09:00");
    expect(screen.getByTestId("chip-plan-b-pickup")).toHaveTextContent("12:00");

    fireEvent.click(screen.getByTestId("stage-next"));
    await waitFor(() => expect(screen.getByText(he.planB.error.placeRequired)).toBeVisible());
    expect(screen.queryByTestId("stage-two")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("chip-plan-b-place"));
    fireEvent.click(screen.getByText("Harish"));
    await submitFromStageOne();
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    expect(mocks.submit.mock.calls[0]![0]).toMatchObject({
      fallback: "alternative",
      alternative: { drop_place_id: "harish", arrive_by: "2044-01-03T07:00:00.000Z", pickup: true, pickup_at: "2044-01-03T10:00:00.000Z" },
    });
  });

  it("drop points are listed before the other places", () => {
    show();
    fireEvent.click(screen.getByTestId("plan-b-link"));
    fireEvent.click(screen.getByTestId("chip-plan-b-place"));
    const options = within(screen.getByTestId("plan-b-place-sheet")).getAllByRole("option").map((option) => option.textContent ?? "");
    expect(options[0]).toContain("Harish");
    expect(options[0]).toContain(he.planB.dropPointTag);
    expect(options[1]).toContain("Destination");
  });

  it("'בלי' removes the line and sends fallback none; 'אסתדר' sends manage", async () => {
    show();
    pickSentenceDestination();
    fireEvent.click(screen.getByTestId("plan-b-link"));
    fireEvent.click(screen.getByTestId("chip-plan-b-kind"));
    fireEvent.click(screen.getByTestId("plan-b-option-manage"));
    expect(screen.getByTestId("chip-plan-b-kind")).toHaveTextContent(he.planB.kind.manage);
    fireEvent.click(screen.getByTestId("chip-plan-b-kind"));
    fireEvent.click(screen.getByTestId("plan-b-option-none"));
    expect(screen.getByTestId("plan-b-link")).toBeVisible();
    await submitFromStageOne();
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    expect(mocks.submit.mock.calls[0]![0]).toMatchObject({ fallback: "none", alternative: null });
  });

  it("'בלי איסוף' drops the pickup part", async () => {
    show();
    pickSentenceDestination();
    fireEvent.click(screen.getByTestId("plan-b-link"));
    fireEvent.click(screen.getByTestId("chip-plan-b-place"));
    fireEvent.click(screen.getByText("Harish"));
    fireEvent.click(screen.getByTestId("chip-plan-b-pickup"));
    fireEvent.click(screen.getByTestId("plan-b-pickup-off"));
    expect(screen.getByTestId("chip-plan-b-pickup")).toHaveTextContent(he.planB.noPickupChip);
    fireEvent.click(screen.getByRole("button", { name: he.requestSentence.sheetDone }));
    await submitFromStageOne();
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    expect(mocks.submit.mock.calls[0]![0].alternative).toMatchObject({ drop_place_id: "harish", pickup: false, pickup_at: null });
  });

  it("the stage-2 recap shows the plan B line", async () => {
    show();
    pickSentenceDestination();
    fireEvent.click(screen.getByTestId("plan-b-link"));
    fireEvent.click(screen.getByTestId("chip-plan-b-place"));
    fireEvent.click(screen.getByText("Harish"));
    fireEvent.click(screen.getByTestId("stage-next"));
    await waitFor(() => expect(screen.getByTestId("recap-plan-b")).toHaveTextContent("אם אין רכב: הקפצה לHarish עד 09:00 ואיסוף משם ב־12:00"));
  });

  it("a pickup place other than the drop place goes into the payload; 'אותו מקום' clears it", async () => {
    show();
    pickSentenceDestination();
    fireEvent.click(screen.getByTestId("plan-b-link"));
    fireEvent.click(screen.getByTestId("chip-plan-b-place"));
    fireEvent.click(screen.getByText("Harish"));
    expect(screen.getByTestId("chip-plan-b-pickup-place")).toHaveTextContent(he.planB.samePlaceChip);
    fireEvent.click(screen.getByTestId("chip-plan-b-pickup-place"));
    fireEvent.click(within(screen.getByTestId("plan-b-pickup-place-sheet")).getByText("Destination"));
    expect(screen.getByTestId("chip-plan-b-pickup-place")).toHaveTextContent("Destination");
    fireEvent.click(screen.getByTestId("stage-next"));
    await waitFor(() => expect(screen.getByTestId("recap-plan-b")).toHaveTextContent("אם אין רכב: הקפצה לHarish עד 09:00, ואיסוף מDestination ב־12:00"));
    fireEvent.click(screen.getByRole("button", { name: he.action.submitRequest }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    expect(mocks.submit.mock.calls[0]![0].alternative).toMatchObject({ drop_place_id: "harish", pickup_place_id: "destination" });
  });
});
