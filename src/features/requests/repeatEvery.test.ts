import { describe, expect, it } from "vitest";

import { repeatEveryLabel, repeatWeeksLabel } from "./repeatEvery";

describe("repeatEveryLabel (REQ §13.159)", () => {
  it("reads one, two and many weeks", () => {
    expect(repeatEveryLabel(1)).toBe("כל שבוע");
    expect(repeatEveryLabel(2)).toBe("כל שבועיים");
    expect(repeatEveryLabel(5)).toBe("כל 5 שבועות");
    expect(repeatWeeksLabel(8)).toBe("8 שבועות");
  });
  it("reads a missing or unknown gap as every week", () => {
    expect(repeatEveryLabel(undefined)).toBe("כל שבוע");
    expect(repeatEveryLabel(9)).toBe("כל שבוע");
  });
});
