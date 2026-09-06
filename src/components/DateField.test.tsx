import { describe, expect, it } from "vitest";

import { datesOfWeek } from "./DateField";

describe("datesOfWeek", () => {
  it("returns the 7 dates of the week starting at weekStart", () => {
    // 2026-09-06 is a Sunday.
    expect(datesOfWeek("2026-09-06")).toEqual([
      "2026-09-06",
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
    ]);
  });

  it("crosses a month boundary correctly", () => {
    const dates = datesOfWeek("2026-09-27");
    expect(dates[0]).toBe("2026-09-27");
    expect(dates[6]).toBe("2026-10-03");
  });
});
