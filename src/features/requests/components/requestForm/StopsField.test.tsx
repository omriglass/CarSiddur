import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { useForm, useWatch } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";

import { he, tv } from "@/i18n/he";

import { StopsField } from "./StopsField";

import type { RequestFormValues } from "../../schema";

// Swap the inline search list for a plain button that commits a fixed place, so this stays a
// focused test of the editor (entry button, blocks, add/remove) rather than the picker.
vi.mock("./sentence/PlacePicker", () => ({
  PlacePicker: ({ onPick }: { onPick: (value: { presetId: string; name: string }) => void }) => (
    <button type="button" onClick={() => onPick({ presetId: "binyamina-dest", name: "בנימינה" })}>pick</button>
  ),
}));

// REQ item 246: the route's hop minutes. Unset = not priced (no hours shown), as before item 246.
const hops = vi.hoisted(() => ({ value: undefined as undefined | ((points: readonly unknown[]) => { hops: number[]; stopMinutes: number }) }));
vi.mock("../../routeHopsQuery", () => ({
  useRouteHopsQuery: (_dept: unknown, points: readonly unknown[]) => ({ data: hops.value?.(points) }),
}));

function render(ui: ReactElement) {
  return rtlRender(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

type Stops = RequestFormValues["outStops"];

function Harness({ hasReturn, outStops = [], returnStops = [], extra = {} }: { hasReturn: boolean; outStops?: Stops; returnStops?: Stops; extra?: Record<string, unknown> }) {
  const form = useForm<RequestFormValues>({
    defaultValues: {
      departmentId: "dept",
      origin: { presetId: "nevo", name: "נבו" },
      destination: { presetId: "haifa", name: "חיפה" },
      outStops,
      returnStops,
      ...extra,
    } as never,
  });
  const stops = useWatch({ control: form.control, name: ["outStops", "returnStops"] });
  const stopHours = useWatch({ control: form.control, name: "stopHours" });
  return (
    <>
      <StopsField form={form} places={[]} hasReturn={hasReturn} />
      <output data-testid="state">{JSON.stringify(stops)}</output>
      <output data-testid="hours">{JSON.stringify(stopHours ?? {})}</output>
    </>
  );
}

const binyamina = { presetId: "binyamina-dest", name: "בנימינה" };

describe("StopsField / StopsSheet (REQUIREMENTS §13.93, TODO ST1 rework)", () => {
  it("shows only the entry button until opened", () => {
    render(<Harness hasReturn={false} />);
    expect(screen.getByTestId("add-stop")).toHaveTextContent(he.request.stopsButton);
    expect(screen.queryByTestId("stops-list")).not.toBeInTheDocument();
  });

  it("lists origin, destination and (with a return) the closing origin", () => {
    render(<Harness hasReturn />);
    fireEvent.click(screen.getByTestId("add-stop"));
    expect(screen.getByTestId("stop-block-origin")).toHaveTextContent("נבו");
    expect(screen.getByTestId("stop-block-destination")).toHaveTextContent("חיפה");
    expect(screen.getByTestId("stop-block-origin-end")).toHaveTextContent("נבו");
  });

  it("has no closing origin without a return leg", () => {
    render(<Harness hasReturn={false} />);
    fireEvent.click(screen.getByTestId("add-stop"));
    expect(screen.queryByTestId("stop-block-origin-end")).not.toBeInTheDocument();
  });

  it("the one add button inserts an out-stop before the destination", () => {
    render(<Harness hasReturn />);
    fireEvent.click(screen.getByTestId("add-stop"));
    fireEvent.click(screen.getByTestId("add-stop-here"));
    fireEvent.click(screen.getByRole("button", { name: "pick" }));
    expect(JSON.parse(screen.getByTestId("state").textContent!)).toEqual([[binyamina], []]);
  });

  it("removes a stop with its ×", () => {
    render(<Harness hasReturn={false} outStops={[binyamina]} />);
    fireEvent.click(screen.getByTestId("add-stop"));
    fireEvent.click(screen.getByTestId("stop-remove"));
    expect(JSON.parse(screen.getByTestId("state").textContent!)).toEqual([[], []]);
  });

  it("moves a stop across the destination with the keyboard (position decides the leg)", () => {
    render(<Harness hasReturn outStops={[binyamina]} />);
    fireEvent.click(screen.getByTestId("add-stop"));
    fireEvent.keyDown(screen.getByTestId("stop-grip"), { key: "ArrowDown" });
    expect(JSON.parse(screen.getByTestId("state").textContent!)).toEqual([[], [binyamina]]);
  });

  it("keeps hidden return stops when the trip has no return and counts only active ones", () => {
    render(<Harness hasReturn={false} returnStops={[binyamina]} />);
    expect(screen.getByTestId("add-stop")).toHaveTextContent(he.request.stopsButton);
    fireEvent.click(screen.getByTestId("add-stop"));
    expect(screen.queryByTestId("stop-block")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("add-stop-here"));
    fireEvent.click(screen.getByRole("button", { name: "pick" }));
    expect(JSON.parse(screen.getByTestId("state").textContent!)).toEqual([[binyamina], [binyamina]]);
  });

  describe("stop hours (REQ item 246)", () => {
    // Every hop 20 minutes, stop minutes 5. Work (חיפה) by 10:00, home by 18:00.
    const priced = { departAnchor: "arrive", arriveByTime: "10:00", flexDepartLate: 0, returnAnchor: "arrive", returnTime: "18:00", flexReturnLate: 0 };
    const withHops = () => { hops.value = (points) => ({ hops: points.slice(1).map(() => 20), stopMinutes: 5 }); };

    it("shows each place's hour: fixed ends with a lock, a stop's worked-out hour with ~", () => {
      withHops();
      render(<Harness hasReturn outStops={[binyamina]} extra={priced} />);
      fireEvent.click(screen.getByTestId("add-stop"));
      expect(screen.getByTestId("end-hour-dest")).toHaveAttribute("data-fixed", "true");
      expect(screen.getByTestId("end-hour-dest")).toHaveTextContent("10:00");
      expect(screen.getByTestId("end-hour-start")).toHaveTextContent(tv("request.stopHoursApprox", { time: "09:15" }));
      expect(screen.getByTestId("stop-hour")).toHaveTextContent(tv("request.stopHoursApprox", { time: "09:35" }));
      expect(screen.getByTestId("stop-hours-summary")).toHaveTextContent(tv("request.stopHoursCountMany", { count: "2" }));
      hops.value = undefined;
    });

    it("fixes a stop's hour with its flexibility and stay; an impossible hour is a warning", () => {
      withHops();
      render(<Harness hasReturn outStops={[binyamina]} extra={priced} />);
      fireEvent.click(screen.getByTestId("add-stop"));
      fireEvent.click(screen.getByTestId("stop-hour"));
      const editor = screen.getByTestId("stop-hours-editor");
      fireEvent.change(within(editor).getByTestId("stop-hours-stay"), { target: { value: "30" } });
      fireEvent.click(within(editor).getByTestId("stop-hours-arrive"));
      fireEvent.change(within(editor).getByTestId("stop-hours-time"), { target: { value: "09:20" } });
      fireEvent.change(within(editor).getByTestId("stop-hours-flex"), { target: { value: "15" } });
      fireEvent.click(within(editor).getByTestId("stop-hours-apply"));
      expect(JSON.parse(screen.getByTestId("hours").textContent!)).toEqual({ "out|p:binyamina-dest": { anchor: "arrive", time: "09:20", flex: 15, stay: 30 } });
      // 09:20 + 30 there + 20 driving = 10:10, past חיפה's fixed 10:00 (no flexibility): a warning, "לו״ז צפוף"
      expect(screen.getByTestId("stop-hours-conflict")).toHaveTextContent(tv("request.stopTight", { place: "חיפה" }));
      hops.value = undefined;
    });

    it("adding a stop offers every position with what changes, smallest change first", () => {
      withHops();
      render(<Harness hasReturn outStops={[binyamina]} extra={priced} />);
      fireEvent.click(screen.getByTestId("add-stop"));
      fireEvent.click(screen.getByTestId("add-stop-here"));
      fireEvent.click(screen.getByRole("button", { name: "pick" }));
      const options = screen.getAllByTestId("stop-option");
      expect(options.length).toBe(3);   // out: before / after the first stop; return: the one position
      fireEvent.click(within(options[0]!).getByTestId("stop-option-add"));
      expect(JSON.parse(screen.getByTestId("state").textContent!)[0].length + JSON.parse(screen.getByTestId("state").textContent!)[1].length).toBe(2);
      hops.value = undefined;
    });
  });
});
