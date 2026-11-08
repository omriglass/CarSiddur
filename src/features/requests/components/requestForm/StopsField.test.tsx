import { fireEvent, render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import { StopsField } from "./StopsField";

import type { RequestFormValues } from "../../schema";

// Swap the real popover/combobox for a plain button that commits a fixed value, so this stays a
// focused unit test of the add flow / route line rather than the destination picker.
vi.mock("@/components/DestinationCombobox", () => ({
  DestinationCombobox: ({ onChange }: { onChange: (value: { presetId: string; name: string }) => void }) => (
    <button type="button" onClick={() => onChange({ presetId: "binyamina-dest", name: "בנימינה" })}>
      pick
    </button>
  ),
}));

function Harness({ hasReturn, outStops = [], returnStops = [] }: { hasReturn: boolean; outStops?: RequestFormValues["outStops"]; returnStops?: RequestFormValues["returnStops"] }) {
  const form = useForm<RequestFormValues>({
    defaultValues: {
      origin: { presetId: "nevo", name: "נבו" },
      destination: { presetId: "haifa", name: "חיפה" },
      outStops,
      returnStops,
    } as never,
  });
  return <StopsField form={form} destinations={[]} hasReturn={hasReturn} />;
}

describe("StopsField (REQUIREMENTS §13.93 'Multi-stop rides', TODO ST1)", () => {
  it("shows only the add link, no route line, when there are no stops", () => {
    render(<Harness hasReturn={false} />);
    expect(screen.getByText(he.request.addStopAny)).toBeInTheDocument();
    expect(screen.queryByTestId("route-line")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "pick" })).not.toBeInTheDocument();
  });

  it("without a return leg opens the picker at once and adds an out-stop to the route line", () => {
    render(<Harness hasReturn={false} />);
    fireEvent.click(screen.getByText(he.request.addStopAny));
    expect(screen.queryByText(he.request.stopLegQuestion)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "pick" }));
    expect(screen.getByTestId("route-line")).toHaveTextContent("נבו");
    expect(screen.getByTestId("route-stop-out")).toHaveTextContent("בנימינה");
    expect(screen.getByTestId("stops-hint")).toHaveTextContent(he.request.stopMinutesHint);
    expect(screen.queryByTestId("add-stop-panel")).not.toBeInTheDocument();
  });

  it("with a return leg asks which leg first, then the picker", () => {
    render(<Harness hasReturn />);
    fireEvent.click(screen.getByText(he.request.addStopAny));
    expect(screen.getByText(he.request.stopLegQuestion)).toBeInTheDocument();
    expect(screen.getByTestId("stop-leg-out")).toHaveTextContent("בדרך לחיפה");
    fireEvent.click(screen.getByTestId("stop-leg-return"));
    fireEvent.click(screen.getByRole("button", { name: "pick" }));
    expect(screen.getByTestId("route-stop-return")).toHaveTextContent("בנימינה");
    expect(screen.getByTestId("route-line")).toHaveTextContent(he.request.routeReturn);
  });

  it("removes a stop via its × chip", () => {
    render(<Harness hasReturn={false} outStops={[{ presetId: "binyamina-dest", name: "בנימינה" }]} />);
    fireEvent.click(screen.getByRole("button", { name: `${he.request.removeStop}: בנימינה` }));
    expect(screen.queryByTestId("route-line")).not.toBeInTheDocument();
  });

  it("keeps hidden return stops out of the line when there is no return", () => {
    render(<Harness hasReturn={false} returnStops={[{ presetId: "binyamina-dest", name: "בנימינה" }]} />);
    expect(screen.queryByTestId("route-line")).not.toBeInTheDocument();
  });

  it("hides the add affordances once 10 out stops exist and there is no return", () => {
    const outStops = Array.from({ length: 10 }, (_, i) => ({ presetId: `d${i}`, name: `יעד ${i}` }));
    render(<Harness hasReturn={false} outStops={outStops} />);
    expect(screen.queryByRole("button", { name: he.request.addStopAny })).not.toBeInTheDocument();
  });
});
