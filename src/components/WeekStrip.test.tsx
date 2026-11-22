import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WeekStrip } from "./WeekStrip";

const zero = { rides: 0, unmet: 0 };

describe("WeekStrip (R22U8)", () => {
  it("marks a day with rides still needing a driver, and only that day", () => {
    const counts = [zero, zero, zero, zero, { rides: 3, unmet: 0, needsDriver: 1 }, zero, zero];
    render(<WeekStrip weekStart="2026-11-29" counts={counts} selected="2026-11-29" onSelect={() => {}} />);
    expect(screen.getByTestId("week-strip-needs-driver-2026-12-03")).toHaveTextContent("1");
    expect(screen.queryByTestId("week-strip-needs-driver-2026-12-02")).toBeNull();
  });
});
