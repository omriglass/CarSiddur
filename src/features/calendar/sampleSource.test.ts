import { describe, expect, it } from "vitest";

import { eventsToAmbientBlocks } from "./ambientBlocks";
import { SAMPLE_CALENDAR_IDS, createSampleCalendarSource } from "./sampleSource";

const FROM = "2026-10-10T00:00:00Z";
const TO = "2026-10-19T00:00:00Z";

describe("sample calendar source", () => {
  const source = createSampleCalendarSource();

  it("lists three colored calendars", async () => {
    const calendars = await source.listCalendars();
    expect(calendars.map((c) => c.id)).toEqual([...SAMPLE_CALENDAR_IDS]);
    expect(new Set(calendars.map((c) => c.color)).size).toBe(3);
  });

  it("is deterministic and filters by calendar", async () => {
    const a = await source.listEvents(SAMPLE_CALENDAR_IDS, FROM, TO);
    const b = await createSampleCalendarSource().listEvents(SAMPLE_CALENDAR_IDS, FROM, TO);
    expect(a).toEqual(b);
    const work = await source.listEvents(["sample-work"], FROM, TO);
    expect(work.length).toBeGreaterThan(0);
    expect(work.every((e) => e.calendarId === "sample-work")).toBe(true);
  });

  it("covers a week with overlap, an overnight event, all-day events and an own color", async () => {
    const events = await source.listEvents(SAMPLE_CALENDAR_IDS, "2026-10-10T21:00:00Z", "2026-10-17T21:00:00Z");
    const timed = events.filter((e) => !e.allDay);
    expect(events.filter((e) => e.allDay).length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.allDay && Date.parse(e.end) - Date.parse(e.start) > 25 * 3600_000)).toBe(true);
    expect(timed.some((a) => timed.some((b) => a.id !== b.id && Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end)))).toBe(true);
    const blocks = eventsToAmbientBlocks(events, "2026-10-11");
    expect(blocks.some((b) => b.endMinutes === 1440)).toBe(true);
    const calendars = await source.listCalendars();
    const colorOf = (id: string) => calendars.find((c) => c.id === id)?.color;
    expect(events.some((e) => e.color !== colorOf(e.calendarId))).toBe(true);
    expect(events.some((e) => e.location) && events.some((e) => e.attendees?.length) && events.some((e) => e.description)).toBe(true);
  });

  it("returns an empty list for an empty or invalid range", async () => {
    expect(await source.listEvents(SAMPLE_CALENDAR_IDS, TO, FROM)).toEqual([]);
  });
});
