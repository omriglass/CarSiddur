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
  useDestinations: () => ({ data: [{ id: "destination", name: "Destination", aliases: [], zone: "", travel_minutes: 30 }] }),
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

/** Sentence layout: open the destination sheet and tap the one seeded place. */
function pickSentenceDestination() {
  fireEvent.click(screen.getByTestId("chip-destination"));
  fireEvent.click(screen.getByText("Destination"));
}

async function goToStageTwo() {
  fireEvent.click(screen.getByTestId("stage-next"));
  await waitFor(() => expect(screen.getByTestId("stage-two")).toBeVisible());
}

function setTime(label: string, value: string) {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

beforeEach(() => {
  mocks.submit.mockReset();
  mocks.submit.mockResolvedValue({ request_id: "request", status: "submitted" });
  mocks.layout.current = "sentence";
  mocks.routeMinutes.current = 45;
  window.localStorage.clear();
  // jsdom has no layout engine: `useScrollToFirstError` scrolls the first bad chip into view.
  Element.prototype.scrollIntoView = vi.fn();
});

describe("RequestForm sentence layout (REQ §13.110)", () => {
  it("renders the sentence with chips that carry their rhf field name, and the first-visit hint once", () => {
    show();
    expect(screen.getByTestId("request-sentence")).toBeVisible();
    for (const field of ["tripType", "destination", "day", "departTime", "returnTime"]) {
      expect(document.querySelector(`[data-testid="request-sentence"] [data-field="${field}"]`)).not.toBeNull();
    }
    expect(screen.getByText(he.requestSentence.hint)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: he.requestSentence.hintDismiss }));
    expect(screen.queryByText(he.requestSentence.hint)).not.toBeInTheDocument();
  });

  it("files an arrive-by request: the payload carries the anchors and the derived car time", async () => {
    show();
    pickSentenceDestination();

    fireEvent.click(screen.getByTestId("chip-out"));
    fireEvent.click(screen.getByRole("radio", { name: he.requestSentence.anchor.outArrive }));
    setTime(he.field.depart, "09:30");
    // The derived line under the time: 09:30 arrive-by minus 45 minutes of route.
    await waitFor(() => expect(screen.getByTestId("time-estimate-out")).toHaveTextContent("08:45"));
    fireEvent.click(screen.getByRole("button", { name: he.requestSentence.sheetDone }));

    await goToStageTwo();
    fireEvent.click(screen.getByRole("button", { name: he.action.submitRequest }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    const payload = mocks.submit.mock.calls[0]![0];
    expect(payload).toMatchObject({
      destination_id: "destination",
      depart_anchor: "arrive",
      arrive_by: "2044-01-03T07:30:00.000Z",
      depart_at: "2044-01-03T06:45:00.000Z",
      return_anchor: "arrive",
      leave_dest_at: null,
    });
  });

  it("files a leave-there return: return_at = leave time + return route, rounded up", async () => {
    mocks.routeMinutes.current = 50;
    show();
    pickSentenceDestination();
    fireEvent.click(screen.getByTestId("chip-return"));
    fireEvent.click(screen.getByRole("radio", { name: he.requestSentence.anchor.returnLeave }));
    setTime(he.field.return, "13:00");
    fireEvent.click(screen.getByRole("button", { name: he.requestSentence.sheetDone }));

    await goToStageTwo();
    fireEvent.click(screen.getByRole("button", { name: he.action.submitRequest }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    expect(mocks.submit.mock.calls[0]![0]).toMatchObject({
      return_anchor: "leave",
      leave_dest_at: "2044-01-03T11:00:00.000Z",
      return_at: "2044-01-03T12:00:00.000Z",
    });
  });

  it("stage 1 offers only המשך; with no destination it stays on stage 1 and opens the destination sheet", async () => {
    show();
    expect(screen.queryByRole("button", { name: he.action.submitRequest })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("stage-next"));
    await waitFor(() => expect(screen.getByPlaceholderText(he.requestSentence.placeSearch)).toBeVisible());
    expect(screen.queryByTestId("stage-two")).not.toBeInTheDocument();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("stage 2 holds the car field (luggage and a specific car are one choice); the recap goes back to stage 1", async () => {
    show();
    pickSentenceDestination();
    await goToStageTwo();
    fireEvent.click(screen.getByTestId("car-choice-luggage"));
    expect(screen.getByTestId("car-choice-luggage")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByTestId("stage-recap"));
    expect(screen.getByTestId("request-sentence")).toBeVisible();
    await goToStageTwo();
    expect(screen.getByTestId("car-choice-luggage")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: he.action.submitRequest }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    expect(mocks.submit.mock.calls[0]![0]).toMatchObject({ has_luggage: true });
  });

  it("the who chip starts the sentence: a member and a guest from its sheet make the verb plural", async () => {
    show();
    const chip = screen.getByTestId("chip-who");
    expect(chip).toHaveTextContent(he.requestSentence.me);
    expect(screen.getByText(he.requestSentence.needs)).toBeVisible();

    fireEvent.click(chip);
    fireEvent.click(screen.getByTestId("who-add-member"));
    fireEvent.click(screen.getByText("Dana"));
    expect(screen.getByTestId("chip-who")).toHaveTextContent(`${he.requestSentence.me} ${he.requestSentence.and}Dana`);
    expect(screen.getByText(he.requestSentence.needsPlural)).toBeVisible();

    fireEvent.click(screen.getByTestId("who-add-guest"));
    fireEvent.change(screen.getByLabelText(he.requestSentence.whoGuestPlaceholder), { target: { value: "Noa" } });
    fireEvent.click(screen.getByRole("button", { name: he.requestSentence.whoGuestAdd }));
    expect(screen.getByTestId("chip-who")).toHaveTextContent(`${he.requestSentence.me}, Dana ${he.requestSentence.and}Noa`);
  });
});

describe("RequestForm time window (REQ §13.112 c)", () => {
  it("'יש לי חלון זמן?' swaps the time chips for 'N hours between A and B'; the payload is the earliest block + slack + the lock", async () => {
    show();
    pickSentenceDestination();
    expect(screen.queryByTestId("chip-window-hours")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("window-link"));

    // defaults: the typed 08:00-12:00 is 4 hours; the window starts at 08:00 and ends two hours after the block
    expect(screen.getByTestId("chip-window-hours")).toHaveTextContent(he.requestSentence.window.hours.replace("{{n}}", "4"));
    expect(screen.getByTestId("chip-window-start")).toHaveTextContent("08:00");
    expect(screen.getByTestId("chip-window-end")).toHaveTextContent("14:00");
    expect(screen.queryByTestId("chip-out")).not.toBeInTheDocument();
    expect(screen.getByTestId("window-link")).toHaveTextContent(he.requestSentence.window.backToFixed);

    fireEvent.click(screen.getByTestId("chip-window-start"));
    setTime(he.requestSentence.window.startAria, "07:00");
    fireEvent.click(screen.getByRole("button", { name: he.requestSentence.sheetDone }));
    // the end follows the start, keeping the slack
    expect(screen.getByTestId("chip-window-end")).toHaveTextContent("13:00");
    fireEvent.click(screen.getByTestId("chip-window-end"));
    setTime(he.requestSentence.window.endAria, "12:00");
    fireEvent.click(screen.getByRole("button", { name: he.requestSentence.sheetDone }));

    await goToStageTwo();
    expect(screen.getByTestId("recap-when")).toHaveTextContent("07:00");
    fireEvent.click(screen.getByRole("button", { name: he.action.submitRequest }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    expect(mocks.submit.mock.calls[0]![0]).toMatchObject({
      duration_locked: true,
      depart_at: "2044-01-03T05:00:00.000Z",
      return_at: "2044-01-03T09:00:00.000Z",
      flex_depart_early: "0",
      flex_depart_late: "01:00:00",
      flex_return_early: "0",
      flex_return_late: "01:00:00",
      depart_anchor: "leave",
      arrive_by: null,
    });
  });

  it("the hours sheet offers 1-6 and 'עוד…' up to 12", () => {
    show();
    fireEvent.click(screen.getByTestId("window-link"));
    fireEvent.click(screen.getByTestId("chip-window-hours"));
    for (const hours of [1, 2, 3, 4, 5, 6]) expect(screen.getByTestId(`window-hours-${hours}`)).toBeVisible();
    expect(screen.queryByTestId("window-hours-7")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("window-hours-more"));
    expect(screen.getByTestId("window-hours-12")).toBeVisible();
    fireEvent.click(screen.getByTestId("window-hours-3"));
    expect(screen.getByTestId("chip-window-hours")).toHaveTextContent(he.requestSentence.window.hours.replace("{{n}}", "3"));
  });

  it("refuses a window shorter than the time needed and goes back to the sheet", async () => {
    show();
    pickSentenceDestination();
    fireEvent.click(screen.getByTestId("window-link"));
    fireEvent.click(screen.getByTestId("chip-window-end"));
    setTime(he.requestSentence.window.endAria, "10:00"); // 08:00-10:00 for 4 hours
    fireEvent.click(screen.getByRole("button", { name: he.requestSentence.sheetDone }));
    fireEvent.click(screen.getByTestId("stage-next"));
    await waitFor(() => expect(screen.getAllByText(he.requestSentence.window.tooShort).length).toBeGreaterThan(0));
    expect(screen.queryByTestId("stage-two")).not.toBeInTheDocument();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("switching back to 'שעות מסוימות' keeps the fixed times, and files an explicit unlocked request", async () => {
    show();
    pickSentenceDestination();
    fireEvent.click(screen.getByTestId("window-link"));
    fireEvent.click(screen.getByTestId("window-link"));
    expect(screen.getByTestId("chip-out")).toHaveTextContent("08:00");
    expect(screen.getByTestId("chip-return")).toHaveTextContent("12:00");
    await goToStageTwo();
    fireEvent.click(screen.getByRole("button", { name: he.action.submitRequest }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    expect(mocks.submit.mock.calls[0]![0]).toMatchObject({ duration_locked: false, depart_at: "2044-01-03T06:00:00.000Z" });
  });

  it("is not offered for a one-way or a הקפצה", () => {
    show();
    expect(screen.getByTestId("window-link")).toBeVisible();
    fireEvent.click(screen.getByTestId("chip-trip"));
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(he.request.tripTypeOneWay) }));
    expect(screen.queryByTestId("window-link")).not.toBeInTheDocument();
  });
});

describe("RequestForm unnamed children (REQ §13.112 d)", () => {
  it("'+ ילד/ה': a child seat and a booster update the chip ('אני ו־2 ילדים') and the filed seat counts", async () => {
    show();
    pickSentenceDestination();
    fireEvent.click(screen.getByTestId("chip-who"));
    fireEvent.click(screen.getByRole("button", { name: he.requestSentence.whoChildSeatsMore }));
    expect(screen.getByTestId("chip-who")).toHaveTextContent(`${he.requestSentence.me} ${he.requestSentence.and}${he.requestSentence.whoMoreChildOne}`);
    fireEvent.click(screen.getByRole("button", { name: he.requestSentence.whoBoostersMore }));
    expect(screen.getByTestId("chip-who")).toHaveTextContent(`${he.requestSentence.me} ${he.requestSentence.andNumber}${he.requestSentence.whoChildMany.replace("{{n}}", "2")}`);
    expect(screen.getByText(he.requestSentence.needsPlural)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: he.requestSentence.sheetDone }));

    await goToStageTwo();
    fireEvent.click(screen.getByRole("button", { name: he.action.submitRequest }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    expect(mocks.submit.mock.calls[0]![0]).toMatchObject({ adults: 1, child_seats: 1, boosters: 1 });
  });

  it("names and unnamed children read together: 'אני, דנה ו־2 ילדים'", () => {
    show();
    fireEvent.click(screen.getByTestId("chip-who"));
    fireEvent.click(screen.getByTestId("who-add-member"));
    fireEvent.click(screen.getByText("Dana"));
    const more = screen.getByRole("button", { name: he.requestSentence.whoChildSeatsMore });
    fireEvent.click(more);
    fireEvent.click(more);
    expect(screen.getByTestId("chip-who")).toHaveTextContent(`${he.requestSentence.me}, Dana ${he.requestSentence.andNumber}${he.requestSentence.whoChildMany.replace("{{n}}", "2")}`);
  });
});

describe("RequestForm classic layout", () => {
  it("never sends the anchor keys (the server keeps and shifts the stored ones)", async () => {
    mocks.layout.current = "classic";
    show();
    expect(screen.queryByTestId("request-sentence")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "pick-destination" }));
    fireEvent.click(screen.getByRole("button", { name: he.action.submitRequest }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    const payload = mocks.submit.mock.calls[0]![0];
    for (const key of ["depart_anchor", "arrive_by", "return_anchor", "leave_dest_at", "duration_locked"]) expect(key in payload).toBe(false);
  });

  it("unnamed adults: the who sheet stepper updates the chip and the filed adult count (R9M1)", async () => {
    show();
    pickSentenceDestination();
    fireEvent.click(screen.getByTestId("chip-who"));
    const more = screen.getByRole("button", { name: he.requestSentence.whoExtraAdultsMore });
    fireEvent.click(more);
    fireEvent.click(more);
    expect(screen.getByTestId("chip-who")).toHaveTextContent(`${he.requestSentence.me} ${he.requestSentence.and}עוד 2`);
    fireEvent.click(screen.getByRole("button", { name: he.requestSentence.sheetDone }));

    await goToStageTwo();
    fireEvent.click(screen.getByRole("button", { name: he.action.submitRequest }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    expect(mocks.submit.mock.calls[0]![0]).toMatchObject({ adults: 3 });
  });

  it("the description and the Sadran note live on stage 1 and reach the payload (owner 2026-10-07)", async () => {
    show();
    pickSentenceDestination();
    fireEvent.click(within(screen.getByTestId("row-notes")).getByRole("button"));
    fireEvent.change(screen.getByLabelText(he.requestSentence.note), { target: { value: "for the Sadran" } });
    await goToStageTwo();
    expect(screen.queryByLabelText(he.requestSentence.note)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.action.submitRequest }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    expect(mocks.submit.mock.calls[0]![0]).toMatchObject({ notes: "for the Sadran" });
  });

  it("confirms a plain submit with a toast when the server reports no outcome (R9M3)", async () => {
    const { toast } = await import("sonner");
    show();
    pickSentenceDestination();
    await goToStageTwo();
    fireEvent.click(screen.getByRole("button", { name: he.action.submitRequest }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(he.request.submitSent));
  });
});
