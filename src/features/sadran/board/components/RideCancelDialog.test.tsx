// R20H1 (owner 2026-11-14): on one day of a multi-day ride the board's cancel asks "only this day / all days".
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import { RideCancelDialog } from "./RideCancelDialog";

const lines = [{ requestId: "q1", name: "נגה" }];

function renderDialog(seriesDay: string | null, onConfirm = vi.fn()) {
  render(<RideCancelDialog open onOpenChange={() => undefined} lines={lines} series={!!seriesDay} seriesDay={seriesDay} onConfirm={onConfirm} />);
  return onConfirm;
}

describe("RideCancelDialog — one day of a multi-day ride (R20H1)", () => {
  it("offers this day first, and confirms only that day", () => {
    const onConfirm = renderDialog("ד׳ 16.9");
    expect(screen.getByText(he.request.seriesCancelTitle)).toBeTruthy();
    expect(screen.getByText("לבטל רק את ד׳ 16.9")).toBeTruthy();
    expect(screen.getByTestId("ride-cancel-only-day").getAttribute("data-state")).toBe("checked");
    expect(screen.queryByText(he.closeRequest.seriesNote)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: he.closeRequest.cancelConfirm }));
    expect(onConfirm).toHaveBeenCalledWith("", [], [], true);
  });

  it("\"כל הימים\" cancels every day, as before", () => {
    const onConfirm = renderDialog("ד׳ 16.9");
    fireEvent.click(screen.getByTestId("ride-cancel-all-days"));
    expect(screen.getByText(he.closeRequest.seriesNote)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: he.closeRequest.cancelConfirm }));
    expect(onConfirm).toHaveBeenCalledWith("", [], [], false);
  });

  it("a one-day ride asks nothing about days", () => {
    renderDialog(null);
    expect(screen.queryByTestId("ride-cancel-scope")).toBeNull();
    expect(screen.getByText(he.closeRequest.cancelTitle)).toBeTruthy();
  });
});
