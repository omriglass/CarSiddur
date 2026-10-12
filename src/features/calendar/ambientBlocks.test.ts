import { describe, expect, it } from "vitest";

import { eventsToAmbientBlocks } from "./ambientBlocks";
import { DEFAULT_DISPLAY_PREFS } from "./displayPrefs";
import type { CalendarEvent } from "./types";

const event = (over: Partial<CalendarEvent>): CalendarEvent => ({
  id: "e1", calendarId: "c1", title: "Dentist", start: "2026-10-12T07:00:00Z", end: "2026-10-12T08:00:00Z", allDay: false, ...over,
});

describe("eventsToAmbientBlocks", () => {
  it("places an event on its Jerusalem day and minutes", () => {
    expect(eventsToAmbientBlocks([event({})], "2026-10-11")).toEqual([
      { id: "c1:e1", carId: "2026-10-12", startMinutes: 10 * 60, endMinutes: 11 * 60, label: "Dentist", lines: ["10:00–11:00"] },
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

  it("draws an all-day event as one band per covered day, with no hours line", () => {
    const blocks = eventsToAmbientBlocks([event({ id: "trip", title: "Trip", allDay: true, start: "2026-10-12T21:00:00Z", end: "2026-10-14T21:00:00Z", location: "Eilat" })], "2026-10-11");
    expect(blocks.map((b) => [b.carId, b.allDay, b.label, b.lines])).toEqual([
      ["2026-10-13", true, "Trip", ["Eilat"]],
      ["2026-10-14", true, "Trip", ["Eilat"]],
    ]);
    expect(new Set(blocks.map((b) => b.id)).size).toBe(2);
  });

  it("puts all-day bands before timed blocks of the same day", () => {
    const blocks = eventsToAmbientBlocks([
      event({ id: "timed", start: "2026-10-12T03:30:00Z", end: "2026-10-12T04:30:00Z" }),
      event({ id: "all", allDay: true, start: "2026-10-11T21:00:00Z", end: "2026-10-12T21:00:00Z" }),
    ], "2026-10-11");
    expect(blocks.map((b) => b.id)).toEqual(["c1:all", "c1:timed"]);
  });

  it("builds lines in order from the display prefs", () => {
    const rich = event({ location: "Clinic", attendees: ["A", "B", "C", "D", "E"], description: "Bring papers" });
    const all = { ...DEFAULT_DISPLAY_PREFS, hours: true, location: true, participants: true, notes: true };
    expect(eventsToAmbientBlocks([rich], "2026-10-11", all)[0]?.lines).toEqual(["10:00–11:00", "Clinic", "A, B, C +2", "Bring papers"]);
    const none = { ...all, hours: false, location: false, participants: false, notes: false };
    expect(eventsToAmbientBlocks([rich], "2026-10-11", none)[0]).not.toHaveProperty("lines");
    expect(eventsToAmbientBlocks([rich], "2026-10-11")[0]?.lines).toEqual(["10:00–11:00", "Clinic"]);
  });

  it("shows each midnight segment's own bounds and passes the color through when calendar colors are on", () => {
    const blocks = eventsToAmbientBlocks([event({ start: "2026-10-12T19:00:00Z", end: "2026-10-12T22:00:00Z", color: "#039be5" })], "2026-10-11", { ...DEFAULT_DISPLAY_PREFS, useCalendarColors: true });
    expect(blocks.map((b) => [b.lines?.[0], b.color])).toEqual([["22:00–24:00", "#039be5"], ["00:00–01:00", "#039be5"]]);
  });

  it("keeps the app's own tint while calendar colors are off (the default)", () => {
    const blocks = eventsToAmbientBlocks([event({ color: "#039be5" })], "2026-10-11");
    expect(blocks.every((b) => b.color === undefined)).toBe(true);
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

  it("puts overlapping events of one day side by side; all-day bands never take a lane", () => {
    const blocks = eventsToAmbientBlocks([
      event({ id: "a" }),
      event({ id: "b", start: "2026-10-12T07:30:00Z", end: "2026-10-12T09:00:00Z" }),
      event({ id: "c", start: "2026-10-12T10:00:00Z", end: "2026-10-12T11:00:00Z" }),
      event({ id: "d", start: "2026-10-11T21:00:00Z", end: "2026-10-12T21:00:00Z", allDay: true }),
    ], "2026-10-11");
    const byId = new Map(blocks.map((b) => [b.id, b]));
    expect([byId.get("c1:a")?.lane, byId.get("c1:b")?.lane, byId.get("c1:a")?.laneCount]).toEqual([0, 1, 2]);
    expect(byId.get("c1:c")?.laneCount).toBeUndefined();
    expect(byId.get("c1:d")?.laneCount).toBeUndefined();
  });
});
