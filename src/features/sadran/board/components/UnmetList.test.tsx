import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WeekRequestRow } from "../../api";
import { he, tv } from "@/i18n/he";
import { UnmetList } from "./UnmetList";

/** The card's "⋮" menu navigates to the edit form, so every render sits in a router. */
function render(ui: ReactElement) {
  const client = new QueryClient();
  const wrap = (node: ReactElement) => <QueryClientProvider client={client}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>;
  const result = rtlRender(wrap(ui));
  return { ...result, rerender: (next: ReactElement) => result.rerender(wrap(next)) };
}

function openMenu() {
  fireEvent.pointerDown(screen.getByTestId("unmet-menu"), { button: 0, ctrlKey: false });
}

const request = {
  id: "return-request", trip_shape: "one_way_from", depart_at: null, return_at: "2026-09-10T06:00:00Z",
  one_way_car_mode: "passenger", destination_travel_minutes: 40, status: "submitted", requester_full_name: "Member",
} as WeekRequestRow;
const item = { request, destinationName: "Destination" };

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  const column = document.createElement("div");
  column.setAttribute("data-car-col-id", "car");
  vi.spyOn(column, "getBoundingClientRect").mockReturnValue({ top: 0, height: 1440 } as DOMRect);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => column });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("one-way unmet cards", () => {
  it("shows the journey ending at arrival and supports dragging it for a proposal", () => {
    const drop = vi.fn();
    render(<UnmetList items={[item]} onAction={vi.fn()} onDragDrop={drop} dayStartMinutes={0} />);
    expect(screen.getByText(/08:15–09:00/)).toBeInTheDocument();
    const grip = screen.getByRole("button", { name: "גרור/י ללוח" });
    fireEvent.pointerDown(grip, { clientX: 20, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 200, clientY: 600 });
    fireEvent.pointerUp(window, { clientX: 200, clientY: 600 });
    expect(drop).toHaveBeenCalledWith(item, "car", 600, undefined);
  });
  it("keeps other times / external / deny / edit in the ⋮ menu only (owner 2026-10-16)", () => {
    const decide = vi.fn();
    render(<UnmetList items={[item]} onAction={vi.fn()} onDecision={decide} />);
    expect(screen.queryByRole("button", { name: he.sadranProposal.suggestTimes })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: he.sadranProposal.solveOutside })).not.toBeInTheDocument();
    openMenu();
    fireEvent.click(screen.getByTestId("unmet-shift"));
    openMenu();
    expect(screen.getByTestId("unmet-edit")).toHaveTextContent(he.unmetCard.editRequest);
    expect(screen.getByTestId("unmet-deny")).toHaveTextContent(he.unmetCard.proposeDeny);
    fireEvent.click(screen.getByTestId("unmet-external"));
    expect(decide.mock.calls).toEqual([[item, "shift"], [item, "external"]]);
  });

  it("states the trip type as a chip and the solver reason in its own prefixed box, only when there is one", () => {
    const { rerender } = render(<UnmetList items={[{ ...item, request: { ...request, trip_type: "one_way" } as WeekRequestRow }]} onAction={vi.fn()} />);
    expect(screen.getByTestId("unmet-trip-type")).toHaveTextContent(he.request.tripTypeOneWay);
    expect(screen.queryByTestId("unmet-reason")).not.toBeInTheDocument();
    rerender(<UnmetList items={[{ ...item, solverInfo: { requestId: "return-request", score: 0, blockers: [], reasonCode: "UNMET_NO_CAR", reason: "אין רכב פנוי", suggestions: [] } }]} onAction={vi.fn()} />);
    expect(screen.getByTestId("unmet-reason")).toHaveTextContent(tv("unmetCard.notPlacedBecause", { reason: "אין רכב פנוי" }));
  });

  it("a click on the grip never places a request", () => {
    const drop = vi.fn();
    render(<UnmetList items={[item]} onAction={vi.fn()} onDragDrop={drop} />);
    const grip = screen.getByRole("button", { name: "גרור/י ללוח" });
    fireEvent.pointerDown(grip, { clientX: 20, clientY: 20 });
    fireEvent.pointerUp(window, { clientX: 20, clientY: 20 });
    expect(drop).not.toHaveBeenCalled();
  });

  // REQ §13.93/SOLVER §3.15 (O4b): a `changeOrigin` suggestion gets the same "הצע" send
  // action as every other suggestion kind — no more "no send action yet" carve-out.
  it("offers a propose action for a changeOrigin suggestion", () => {
    const onAction = vi.fn();
    const suggestion = {
      kind: "changeOrigin" as const,
      requestId: "return-request",
      carId: "car-1",
      originId: "dest-haifa",
      window: { start: 0, end: 60 },
      reasonCode: "SUGGEST_CHANGE_ORIGIN",
      reason: "יש רכב פנוי מחיפה",
      cost: 0,
      confidence: 0.4,
    };
    const itemWithSuggestion = {
      ...item,
      solverInfo: { requestId: "return-request", score: 0, blockers: [], reasonCode: "UNMET_NO_CAR", reason: "אין רכב פנוי", suggestions: [suggestion] },
    };
    render(<UnmetList items={[itemWithSuggestion]} onAction={onAction} />);
    expect(screen.getByText("יש רכב פנוי מחיפה")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.action.propose }));
    expect(onAction).toHaveBeenCalledWith(itemWithSuggestion, suggestion);
  });

  // Regression: the desktop board's side panel (`BoardScreen.tsx`) renders its own
  // "לא שובצו (N)" heading right above this list, which used to duplicate this component's own
  // heading (`UnmetList.tsx`); `showHeading` lets a caller that already has one opt out while
  // the phone list-mode segment and the ride-detail sheet keep the (default) built-in heading.
  it("renders its own heading by default, and omits it when showHeading is false", () => {
    const title = tv("sadranBoard.unmetTitle", { count: "1" });
    const { rerender } = render(<UnmetList items={[item]} onAction={vi.fn()} />);
    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    rerender(<UnmetList items={[item]} onAction={vi.fn()} showHeading={false} />);
    expect(screen.queryByRole("heading", { name: title })).not.toBeInTheDocument();
  });
});

describe("plan B and אסתדר on the unmet card (REQ §13.112)", () => {
  const roundTrip = { ...request, id: "rt", trip_shape: "round_trip", trip_type: "round_trip", depart_at: "2026-09-10T05:00:00Z", return_at: "2026-09-10T09:00:00Z" } as WeekRequestRow;
  const alt = { drop_place_id: "p", drop_place_text: null, arrive_by: "2026-09-10T05:00:00Z", pickup: true, pickup_at: "2026-09-10T16:00:00Z", applied_at: null, drop_place: { name: "צומת חריש" } };
  const suggestion = { kind: "useAlternative" as const, requestId: "rt", carId: "c1", departSlot: 10, returnSlot: 20, reasonCode: "SUGGEST_USE_ALTERNATIVE", reason: "תוכנית ב׳ של המבקש/ת", cost: 0, confidence: 0.4 };
  const solverInfo = { requestId: "rt", score: 0, blockers: [], reasonCode: "UNMET_NO_CAR", reason: "x", suggestions: [suggestion] };

  it("shows the member's plan B, marks the suggestion 'possible' and proposes it", () => {
    const onAction = vi.fn();
    const planB = { destinationName: "Haifa", request: { ...roundTrip, fallback: "alternative", alternative: alt } as WeekRequestRow, solverInfo };
    render(<UnmetList items={[planB]} onAction={onAction} onDecision={vi.fn()} />);
    expect(screen.getByTestId("unmet-fallback")).toHaveTextContent("תוכנית ב׳: הקפצה לצומת חריש עד 08:00, ואיסוף משם ב־19:00");
    expect(screen.getByTestId("unmet-plan-b-possible")).toHaveTextContent(he.sadranPlanB.possible);
    fireEvent.click(screen.getByTestId("unmet-plan-b-propose"));
    expect(onAction).toHaveBeenCalledWith(planB, suggestion);
    openMenu();
    expect(screen.getByTestId("unmet-external")).toBeInTheDocument();
  });
  it("אסתדר: shows the word and offers no outside-solution action", () => {
    const manage = { destinationName: "Haifa", request: { ...roundTrip, fallback: "manage", alternative: null } as WeekRequestRow };
    render(<UnmetList items={[manage]} onAction={vi.fn()} onDecision={vi.fn()} />);
    expect(screen.getByTestId("unmet-fallback")).toHaveTextContent("אסתדר");
    openMenu();
    expect(screen.queryByTestId("unmet-external")).not.toBeInTheDocument();
  });
});
