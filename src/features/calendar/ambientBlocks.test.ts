import { describe, expect, it } from "vitest";

import { eventsToAmbientBlocks } from "./ambientBlocks";
import type { CalendarEvent } from "./types";

const event = (over: Partial<CalendarEvent>): CalendarEvent => ({
  id: "e1", calendarId: "c1", title: "Dentist", start: "2026-10-12T07:00:00Z", end: "2026-10-12T08:00:00Z", allDay: false, ...over,
});

describe("eventsToAmbientBlocks", () => {
  it("places an event on its Jerusalem day and minutes", () => {
    expect(eventsToAmbientBlocks([event({})], "2026-10-11")).toEqual([
      { id: "c1:e1", carId: "2026-10-12", startMinutes: 10 * 60, endMinutes: 11 * 60, label: "Dentist" },
    ]);
  });

  it("splits an event that spans midnight into one block per day", () => {
    const blocks = eventsToAmbientBlocks([event({ start: "2026-10-12T19:00:00Z", end: "2026-10-12T22:00:00Z" })], "2026-10-11");
    expect(blocks.map((b) => [b.carId, b.startMinutes, b.endMinutes])).toEqual([
      ["2026-10-12", 22 * 60, 1440],
      ["2026-10-13", 0, 60],
    ]);
    expect(new Set(blocks.map((b) => b.id)).size).toBe(2);
  });

  it("skips all-day events", () => {
    expect(eventsToAmbientBlocks([event({ allDay: true, start: "2026-10-11T21:00:00Z", end: "2026-10-12T21:00:00Z" })], "2026-10-11")).toEqual([]);
  });

  it("drops events outside the week and sorts by day then start", () => {
    const blocks = eventsToAmbientBlocks([
      event({ id: "late", start: "2026-10-13T10:00:00Z", end: "2026-10-13T11:00:00Z" }),
      event({ id: "outside", start: "2026-10-20T10:00:00Z", end: "2026-10-20T11:00:00Z" }),
      event({ id: "early", start: "2026-10-12T05:00:00Z", end: "2026-10-12T06:00:00Z" }),
    ], "2026-10-11");
    expect(blocks.map((b) => b.id)).toEqual(["c1:early", "c1:late"]);
  });

  it("keeps a zero-length event visible", () => {
    const [block] = eventsToAmbientBlocks([event({ end: "2026-10-12T07:00:00Z" })], "2026-10-11");
    expect(block?.endMinutes).toBeGreaterThan(block?.startMinutes ?? 0);
  });
});
