import { describe, expect, it } from "vitest";

import { groupByDay } from "./dayGrouping";

// weekStart is a Sunday; instants are given in UTC but Asia/Jerusalem in
// September is UTC+3 (IDT), so e.g. "T05:00:00Z" lands on the same
// Jerusalem calendar day as "T00:00" local.
const WEEK_START = "2026-09-13"; // Sunday

interface Item {
  id: string;
  startsAt: string;
}

describe("groupByDay", () => {
  it("returns 7 buckets, Sunday first", () => {
    const buckets = groupByDay<Item>([], WEEK_START, (i) => i.startsAt);
    expect(buckets).toHaveLength(7);
    expect(buckets[0]!.date).toBe("2026-09-13");
    expect(buckets[6]!.date).toBe("2026-09-19");
    expect(buckets.map((b) => b.dayIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("buckets items by their Asia/Jerusalem calendar day", () => {
    const items: Item[] = [
      { id: "tuesday-morning", startsAt: "2026-09-15T05:30:00Z" }, // 08:30 IDT Tue
      { id: "tuesday-evening", startsAt: "2026-09-15T15:00:00Z" }, // 18:00 IDT Tue
      { id: "wednesday", startsAt: "2026-09-16T04:00:00Z" }, // 07:00 IDT Wed
    ];
    const buckets = groupByDay(items, WEEK_START, (i) => i.startsAt);
    expect(buckets[2]!.items.map((i) => i.id)).toEqual(["tuesday-morning", "tuesday-evening"]);
    expect(buckets[3]!.items.map((i) => i.id)).toEqual(["wednesday"]);
    expect(buckets[0]!.items).toHaveLength(0);
  });

  it("sorts each day's items by start time", () => {
    const items: Item[] = [
      { id: "later", startsAt: "2026-09-15T15:00:00Z" },
      { id: "earlier", startsAt: "2026-09-15T05:30:00Z" },
    ];
    const buckets = groupByDay(items, WEEK_START, (i) => i.startsAt);
    expect(buckets[2]!.items.map((i) => i.id)).toEqual(["earlier", "later"]);
  });

  it("a midnight-boundary instant (23:30 IDT Saturday = 20:30Z) lands on Saturday, not the next week", () => {
    const items: Item[] = [{ id: "late-saturday", startsAt: "2026-09-19T20:30:00Z" }];
    const buckets = groupByDay(items, WEEK_START, (i) => i.startsAt);
    expect(buckets[6]!.items.map((i) => i.id)).toEqual(["late-saturday"]);
  });
});
