import { useContext } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SheetPortalContext } from "@/components/SheetPortalContext";

import { PortalDialogContent } from "./PortalDialogContent";

function Probe() {
  const node = useContext(SheetPortalContext);
  return <div data-testid="probe" data-has-node={node ? "yes" : "no"} />;
}

describe("PortalDialogContent", () => {
  it("provides its own content node via SheetPortalContext", () => {
    render(
      <Dialog open onOpenChange={() => {}}>
        <PortalDialogContent>
          <DialogHeader>
            <DialogTitle>title</DialogTitle>
          </DialogHeader>
          <Probe />
        </PortalDialogContent>
      </Dialog>,
    );
    const probe = screen.getByTestId("probe");
    expect(probe.getAttribute("data-has-node")).toBe("yes");
    const content = screen.getByRole("dialog");
    expect(content.contains(probe)).toBe(true);
  });

  it("leaves SheetPortalContext at its default (null) outside PortalDialogContent", () => {
    render(<Probe />);
    expect(screen.getByTestId("probe").getAttribute("data-has-node")).toBe("no");
  });
});
