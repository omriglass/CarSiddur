import { DirectionProvider } from "@radix-ui/react-direction";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RideTypeChips } from "./RideTypeChips";

const types = [
  { id: "a", nameHe: "A" },
  { id: "b", nameHe: "B" },
];

/**
 * Radix `ToggleGroup` (and `Select`, `DropdownMenu`, …) stamps `dir` on its DOM root from
 * `useDirection()`, which defaults to `ltr` without a `DirectionProvider` — so the chips
 * rendered left-to-right inside the RTL form (owner bug report 2026-09-14). `main.tsx`
 * mounts one `DirectionProvider dir="rtl"` around the whole app; this pins the mechanism.
 */
describe("RideTypeChips direction", () => {
  it("renders left-to-right when no DirectionProvider is mounted (the bug)", () => {
    const { getByRole } = render(<RideTypeChips types={types} value="a" onChange={() => {}} />);
    expect(getByRole("radiogroup")).toHaveAttribute("dir", "ltr");
  });

  it("follows the app-level DirectionProvider (the fix)", () => {
    const { getByRole } = render(
      <DirectionProvider dir="rtl">
        <RideTypeChips types={types} value="a" onChange={() => {}} />
      </DirectionProvider>,
    );
    expect(getByRole("radiogroup")).toHaveAttribute("dir", "rtl");
  });
});
