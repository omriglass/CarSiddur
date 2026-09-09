import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "./ConfirmDialog";
import { he } from "@/i18n/he";

describe("ConfirmDialog", () => {
  it("renders title, description and default cancel/confirm labels", () => {
    render(
      <ConfirmDialog open title="מחיקת רכב" description="לא ניתן לשחזר" onOpenChange={() => {}} onConfirm={() => {}} />,
    );
    expect(screen.getByText("מחיקת רכב")).toBeInTheDocument();
    expect(screen.getByText("לא ניתן לשחזר")).toBeInTheDocument();
    expect(screen.getByText(he.common.cancel)).toBeInTheDocument();
    expect(screen.getByText(he.common.confirm)).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    render(<ConfirmDialog open={false} title="t" onOpenChange={() => {}} onConfirm={() => {}} />);
    expect(screen.queryByText("t")).not.toBeInTheDocument();
  });

  it("calls onConfirm when the confirm button is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog open title="t" confirmLabel="אשר" onOpenChange={() => {}} onConfirm={onConfirm} />,
    );
    fireEvent.click(screen.getByText("אשר"));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("calls onOpenChange(false) when cancel is clicked", () => {
    const onOpenChange = vi.fn();
    render(<ConfirmDialog open title="t" onOpenChange={onOpenChange} onConfirm={() => {}} />);
    fireEvent.click(screen.getByText(he.common.cancel));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("disables both buttons while loading and does not call onOpenChange on outside interaction", () => {
    const onOpenChange = vi.fn();
    render(<ConfirmDialog open title="t" loading onOpenChange={onOpenChange} onConfirm={() => {}} />);
    expect(screen.getByText(he.common.cancel)).toBeDisabled();
    expect(screen.getByText(he.common.confirm)).toBeDisabled();
  });

  it("disables the confirm button when confirmDisabled is set, independent of loading", () => {
    render(<ConfirmDialog open title="t" confirmDisabled onOpenChange={() => {}} onConfirm={() => {}} />);
    expect(screen.getByText(he.common.confirm)).toBeDisabled();
    expect(screen.getByText(he.common.cancel)).not.toBeDisabled();
  });

  it("renders the destructive variant confirm button when destructive is set", () => {
    render(<ConfirmDialog open title="t" destructive onOpenChange={() => {}} onConfirm={() => {}} />);
    expect(screen.getByText(he.common.confirm).closest("button")).toHaveClass("bg-destructive");
  });

  it("renders extra body content passed as children", () => {
    render(
      <ConfirmDialog open title="t" onOpenChange={() => {}} onConfirm={() => {}}>
        <p>תוכן נוסף</p>
      </ConfirmDialog>,
    );
    expect(screen.getByText("תוכן נוסף")).toBeInTheDocument();
  });
});
