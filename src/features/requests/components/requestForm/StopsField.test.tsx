import { fireEvent, render, screen } from "@testing-library/react";
import { useForm, useWatch } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import { StopsField } from "./StopsField";

import type { RequestFormValues } from "../../schema";

// Swap the inline search list for a plain button that commits a fixed place, so this stays a
// focused test of the editor (entry button, blocks, add/remove) rather than the picker.
vi.mock("./sentence/PlacePicker", () => ({
  PlacePicker: ({ onPick }: { onPick: (value: { presetId: string; name: string }) => void }) => (
    <button type="button" onClick={() => onPick({ presetId: "binyamina-dest", name: "בנימינה" })}>pick</button>
  ),
}));

type Stops = RequestFormValues["outStops"];

function Harness({ hasReturn, outStops = [], returnStops = [] }: { hasReturn: boolean; outStops?: Stops; returnStops?: Stops }) {
  const form = useForm<RequestFormValues>({
    defaultValues: {
      origin: { presetId: "nevo", name: "נבו" },
      destination: { presetId: "haifa", name: "חיפה" },
      outStops,
      returnStops,
    } as never,
  });
  const stops = useWatch({ control: form.control, name: ["outStops", "returnStops"] });
  return (
    <>
      <StopsField form={form} places={[]} hasReturn={hasReturn} />
      <output data-testid="state">{JSON.stringify(stops)}</output>
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
});
