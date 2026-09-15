import { describe, expect, it } from "vitest";

import { dayLabel } from "./dayLabel";

describe("dayLabel", () => {
  it("labels a Sunday day key with the Hebrew Sunday letter, geresh and d.M", () => {
    expect(dayLabel("2026-09-13")).toBe("א׳ 13.9");
  });

  it("labels a Saturday day key with the Hebrew Saturday letter, geresh and d.M", () => {
    expect(dayLabel("2026-09-19")).toBe("ש׳ 19.9");
  });
});
