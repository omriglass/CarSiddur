import { describe, expect, it } from "vitest";

import { groupRidesByDay } from "./listOrder";

describe("groupRidesByDay", () => {
  it("groups by Jerusalem day and sorts by start, then car name, then id", () => {
    const rides = [
      { id: "d", startsAt: "2026-10-26T10:00:00Z", carName: "ב" },
      { id: "c", startsAt: "2026-10-25T08:00:00Z", carName: "ב" },
      { id: "b", startsAt: "2026-10-25T08:00:00Z", carName: "א" },
      { id: "a", startsAt: "2026-10-25T06:00:00Z", carName: "ג" },
      { id: "e", startsAt: "2026-10-25T22:30:00Z", carName: "א" },
    ];
    const groups = groupRidesByDay(rides);
    expect(groups.map((g) => g.day)).toEqual(["2026-10-25", "2026-10-26"]);
    expect(groups[0]!.rides.map((r) => r.id)).toEqual(["a", "b", "c"]);
    // 22:30Z is already the next Jerusalem day (UTC+2/3), so it leads that day.
    expect(groups[1]!.rides.map((r) => r.id)).toEqual(["e", "d"]);
  });
});
