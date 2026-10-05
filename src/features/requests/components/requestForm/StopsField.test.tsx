import { fireEvent, render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";

import { StopsField } from "./StopsField";

import type { RequestFormValues } from "../../schema";

// Same mocking idiom `QuickRequestSheet.test.tsx` uses: swap the real popover/combobox for a
// plain button that commits a fixed value, so this stays a focused unit test of the chips
// themselves (add/remove/collapse) rather than the destination picker.
vi.mock("@/components/DestinationCombobox", () => ({
  DestinationCombobox: ({ onChange }: { onChange: (value: { presetId: string; name: string }) => void }) => (
    <button type="button" onClick={() => onChange({ presetId: "binyamina-dest", name: "בנימינה" })}>
      pick
    </button>
  ),
}));

function Harness({ initial = [] as RequestFormValues["outStops"] }: { initial?: RequestFormValues["outStops"] }) {
  const form = useForm<Pick<RequestFormValues, "outStops">>({ defaultValues: { outStops: initial } });
  return (
    <StopsField
      control={form.control as never}
      name="outStops"
      destinations={[]}
      addLabel="+ עצירה"
      removeAriaLabel="הסרת עצירה"
    />
  );
}

describe("StopsField (REQUIREMENTS §13.93 'Multi-stop rides')", () => {
  it("shows only the add link when there are no stops yet", () => {
    render(<Harness />);
    expect(screen.getByText("+ עצירה")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "pick" })).not.toBeInTheDocument();
  });

  it("opens the picker on tap, adds a chip, and closes itself again", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("+ עצירה"));
    expect(screen.getByRole("button", { name: "pick" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "pick" }));
    expect(screen.getByText("בנימינה")).toBeInTheDocument();
    // Closes back to the collapsed "+ עצירה" link — nothing extra stays visible until used again.
    expect(screen.queryByRole("button", { name: "pick" })).not.toBeInTheDocument();
    expect(screen.getByText("+ עצירה")).toBeInTheDocument();
  });

  it("removes a chip via its × button", () => {
    render(<Harness initial={[{ presetId: "binyamina-dest", name: "בנימינה" }]} />);
    expect(screen.getByText("בנימינה")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "הסרת עצירה" }));
    expect(screen.queryByText("בנימינה")).not.toBeInTheDocument();
  });

  it("hides the add link once 10 stops are already chipped", () => {
    const initial = Array.from({ length: 10 }, (_, i) => ({ presetId: `dest-${i}`, name: `יעד ${i}` }));
    render(<Harness initial={initial} />);
    expect(screen.queryByText("+ עצירה")).not.toBeInTheDocument();
  });
});
