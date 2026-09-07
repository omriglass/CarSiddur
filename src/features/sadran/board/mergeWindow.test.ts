import { describe, expect, it } from "vitest";
import { expandedMergeWindow } from "./mergeWindow";

describe("expanded merge window", () => {
  it("retains the earlier passenger departure and the host return", () => {
    expect(expandedMergeWindow(
      { startsAt: "2042-01-05T07:15:00+02:00", endsAt: "2042-01-05T10:00:00+02:00" },
      { startsAt: "2042-01-05T07:00:00+02:00", endsAt: "2042-01-05T07:30:00+02:00" },
    )).toEqual({ startsAt: "2042-01-05T05:00:00.000Z", endsAt: "2042-01-05T08:00:00.000Z" });
  });
  it("also expands for later return-only passengers", () => {
    expect(expandedMergeWindow(
      { startsAt: "2042-01-05T07:15:00+02:00", endsAt: "2042-01-05T10:00:00+02:00" },
      { startsAt: "2042-01-05T09:45:00+02:00", endsAt: "2042-01-05T10:15:00+02:00" },
    ).endsAt).toBe("2042-01-05T08:15:00.000Z");
  });
});
