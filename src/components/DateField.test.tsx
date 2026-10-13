import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DateField } from "./DateField";

describe("DateField multi-day range (owner 2026-10-13)", () => {
  it("shades every day from the departure up to the chosen return, not the return itself", () => {
    // Departure Thursday 15.10, return Monday 19.10; the picker offers the days after the departure.
    const { container } = render(<DateField weekStart="2026-10-16" dayCount={13} value="2026-10-19" onChange={vi.fn()} rangeStart="2026-10-15" />);
    const shaded = [...container.querySelectorAll("[data-in-range]")].map((el) => el.textContent);
    expect(shaded).toEqual(["ה15.10", "ו16.10", "ש17.10", "א18.10"]);
    expect(container.querySelector('[aria-checked="true"]')?.textContent).toBe("ב19.10");
  });

  it("shades nothing while the return is the departure day itself", () => {
    const { container } = render(<DateField weekStart="2026-10-16" dayCount={13} value="2026-10-15" onChange={vi.fn()} rangeStart="2026-10-15" />);
    expect(container.querySelectorAll("[data-in-range]")).toHaveLength(0);
  });
});
