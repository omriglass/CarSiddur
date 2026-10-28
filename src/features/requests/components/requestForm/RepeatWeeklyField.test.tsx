import { fireEvent, render, screen } from "@testing-library/react";
import { useForm, useWatch, type Control } from "react-hook-form";
import { describe, expect, it } from "vitest";

import { RepeatWeeklyField } from "./RepeatWeeklyField";

import type { RequestFormValues } from "../../schema";

function Spy({ control }: { control: Control<RequestFormValues> }) {
  return <output data-testid="value">{String(useWatch({ control, name: "repeatEveryWeeks" }))}</output>;
}

function Harness({ repeatWeekly, repeatEveryWeeks }: { repeatWeekly: boolean; repeatEveryWeeks?: number }) {
  const form = useForm<RequestFormValues>({ defaultValues: { repeatWeekly, repeatEveryWeeks } as RequestFormValues });
  return (
    <>
      <RepeatWeeklyField control={form.control} />
      <Spy control={form.control} />
    </>
  );
}

describe("RepeatWeeklyField (REQ §13.159)", () => {
  it("off: today's switch only, no gap line", () => {
    render(<Harness repeatWeekly={false} />);
    expect(screen.getByText("בקשה חוזרת (כל שבוע)")).toBeInTheDocument();
    expect(screen.queryByTestId("repeat-every")).toBeNull();
  });

  it("on: one quiet line; 'שינוי' opens the 1–8 selector and a pick closes it", () => {
    render(<Harness repeatWeekly />);
    expect(screen.getByTestId("repeat-every")).toHaveTextContent("כל שבוע");
    fireEvent.click(screen.getByRole("button", { name: "שינוי" }));
    const select = screen.getByTestId("repeat-every-select");
    expect(select.querySelectorAll("option")).toHaveLength(8);
    fireEvent.change(select, { target: { value: "2" } });
    expect(screen.getByTestId("value")).toHaveTextContent("2");
    expect(screen.queryByTestId("repeat-every-select")).toBeNull();
    expect(screen.getByTestId("repeat-every")).toHaveTextContent("כל שבועיים");
    expect(screen.getByText(/נציע לך את הבקשה הזאת כל שבועיים/)).toBeInTheDocument();
  });

  it("turning the switch on from off shows the gap line", () => {
    render(<Harness repeatWeekly={false} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByTestId("repeat-every")).toHaveTextContent("כל שבוע");
  });
});
