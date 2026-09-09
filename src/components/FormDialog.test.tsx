import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FormDialog } from "./FormDialog";
import { he } from "@/i18n/he";

describe("FormDialog", () => {
  it("renders title, description and children fields, with default save/cancel labels", () => {
    render(
      <FormDialog open title="ערוך רכב" description="פרטי הרכב" onOpenChange={() => {}} onSubmit={() => {}}>
        <input aria-label="שם" />
      </FormDialog>,
    );
    expect(screen.getByText("ערוך רכב")).toBeInTheDocument();
    expect(screen.getByText("פרטי הרכב")).toBeInTheDocument();
    expect(screen.getByLabelText("שם")).toBeInTheDocument();
    expect(screen.getByText(he.common.cancel)).toBeInTheDocument();
    expect(screen.getByText(he.common.save)).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    render(
      <FormDialog open={false} title="t" onOpenChange={() => {}} onSubmit={() => {}}>
        <div />
      </FormDialog>,
    );
    expect(screen.queryByText("t")).not.toBeInTheDocument();
  });

  it("calls onSubmit when the submit button is clicked", () => {
    const onSubmit = vi.fn();
    render(
      <FormDialog open title="t" submitLabel="שמור/י שינויים" onOpenChange={() => {}} onSubmit={onSubmit}>
        <div />
      </FormDialog>,
    );
    fireEvent.click(screen.getByText("שמור/י שינויים"));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("calls onOpenChange(false) when cancel is clicked", () => {
    const onOpenChange = vi.fn();
    render(
      <FormDialog open title="t" onOpenChange={onOpenChange} onSubmit={() => {}}>
        <div />
      </FormDialog>,
    );
    fireEvent.click(screen.getByText(he.common.cancel));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("disables both buttons while loading", () => {
    render(
      <FormDialog open title="t" loading onOpenChange={() => {}} onSubmit={() => {}}>
        <div />
      </FormDialog>,
    );
    expect(screen.getByText(he.common.cancel)).toBeDisabled();
    expect(screen.getByText(he.common.save)).toBeDisabled();
  });

  it("disables the submit button when submitDisabled is set, independent of loading", () => {
    render(
      <FormDialog open title="t" submitDisabled onOpenChange={() => {}} onSubmit={() => {}}>
        <div />
      </FormDialog>,
    );
    expect(screen.getByText(he.common.save)).toBeDisabled();
    expect(screen.getByText(he.common.cancel)).not.toBeDisabled();
  });

  it("renders a custom footer instead of the default cancel/submit pair when provided", () => {
    render(
      <FormDialog open title="t" onOpenChange={() => {}} onSubmit={() => {}} footer={<button>מותאם</button>}>
        <div />
      </FormDialog>,
    );
    expect(screen.getByText("מותאם")).toBeInTheDocument();
    expect(screen.queryByText(he.common.save)).not.toBeInTheDocument();
  });
});
