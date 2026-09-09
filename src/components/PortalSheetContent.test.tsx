import { useContext } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Sheet, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SheetPortalContext } from "@/components/SheetPortalContext";

import { PortalSheetContent } from "./PortalSheetContent";

function Probe() {
  const node = useContext(SheetPortalContext);
  return <div data-testid="probe" data-has-node={node ? "yes" : "no"} />;
}

describe("PortalSheetContent", () => {
  it("provides its own content node via SheetPortalContext", () => {
    render(
      <Sheet open onOpenChange={() => {}}>
        <PortalSheetContent>
          <SheetHeader>
            <SheetTitle>title</SheetTitle>
          </SheetHeader>
          <Probe />
        </PortalSheetContent>
      </Sheet>,
    );
    const probe = screen.getByTestId("probe");
    expect(probe.getAttribute("data-has-node")).toBe("yes");
    // The context value is the sheet's own content node — a real ancestor
    // of the consumer, not just some non-null placeholder.
    const content = screen.getByRole("dialog");
    expect(content.contains(probe)).toBe(true);
  });

  it("leaves SheetPortalContext at its default (null) outside PortalSheetContent", () => {
    render(<Probe />);
    expect(screen.getByTestId("probe").getAttribute("data-has-node")).toBe("no");
  });
});
