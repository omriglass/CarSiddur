import { describe, expect, it } from "vitest";

import { dayLabel } from "./dayLabel";

describe("dayLabel", () => {
  it("labels a Sunday day key with the Hebrew Sunday letter and dd.MM", () => {
    expect(dayLabel("2026-09-13")).toBe("א 13.09");
  });

  it("labels a Saturday day key with the Hebrew Saturday letter and dd.MM", () => {
    expect(dayLabel("2026-09-19")).toBe("ש 19.09");
  });
});
