import { describe, expect, it, vi } from "vitest";

import { CalendarAuthError, createGoogleCalendarSource, toCalendarEvent } from "./googleSource";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("toCalendarEvent", () => {
  it("maps a timed event to UTC instants", () => {
    const event = toCalendarEvent({ id: "e1", summary: "Dentist", start: { dateTime: "2026-10-12T09:00:00+03:00" }, end: { dateTime: "2026-10-12T10:00:00+03:00" } }, "cal");
    expect(event).toEqual({ id: "e1", calendarId: "cal", title: "Dentist", start: "2026-10-12T06:00:00.000Z", end: "2026-10-12T07:00:00.000Z", allDay: false });
  });

  it("maps an all-day event to Jerusalem midnights (end exclusive)", () => {
    const event = toCalendarEvent({ id: "e2", summary: "Holiday", start: { date: "2026-10-12" }, end: { date: "2026-10-13" } }, "cal");
    expect(event).toMatchObject({ allDay: true, start: "2026-10-11T21:00:00.000Z", end: "2026-10-12T21:00:00.000Z" });
  });

  it("drops cancelled occurrences and events without times; a missing title is empty", () => {
    expect(toCalendarEvent({ id: "x", status: "cancelled", start: { dateTime: "2026-10-12T09:00:00Z" }, end: { dateTime: "2026-10-12T10:00:00Z" } }, "cal")).toBeNull();
    expect(toCalendarEvent({ id: "y" }, "cal")).toBeNull();
    expect(toCalendarEvent({ id: "z", start: { dateTime: "2026-10-12T09:00:00Z" }, end: { dateTime: "2026-10-12T10:00:00Z" } }, "cal")?.title).toBe("");
  });
});

describe("createGoogleCalendarSource", () => {
  it("lists calendars across pages, primary first, with the bearer token", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: "b", summary: "Work" }], nextPageToken: "p2" }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: "a", summary: "me@example.com", primary: true }, { id: "c", summary: "Kids", summaryOverride: "Children" }] }));
    const source = createGoogleCalendarSource("tok", fetchImpl);
    const calendars = await source.listCalendars();
    expect(calendars.map((c) => [c.id, c.name, c.primary])).toEqual([["a", "me@example.com", true], ["c", "Children", false], ["b", "Work", false]]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("pageToken=p2");
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual({ headers: { Authorization: "Bearer tok" } });
  });

  it("reads expanded occurrences per calendar and skips a calendar it cannot read", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/calendars/gone/")) return jsonResponse({}, 404);
      return jsonResponse({ items: [{ id: "e", summary: "Yoga", start: { dateTime: "2026-10-12T17:00:00Z" }, end: { dateTime: "2026-10-12T18:00:00Z" } }] });
    });
    const source = createGoogleCalendarSource("tok", fetchImpl as unknown as typeof fetch);
    const events = await source.listEvents(["mine", "gone"], "2026-10-10T00:00:00Z", "2026-10-19T00:00:00Z");
    expect(events).toEqual([{ id: "e", calendarId: "mine", title: "Yoga", start: "2026-10-12T17:00:00.000Z", end: "2026-10-12T18:00:00.000Z", allDay: false }]);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("singleEvents=true");
  });

  it("turns 401 into CalendarAuthError", async () => {
    const source = createGoogleCalendarSource("expired", vi.fn().mockResolvedValue(jsonResponse({}, 401)));
    await expect(source.listEvents(["mine"], "2026-10-10T00:00:00Z", "2026-10-19T00:00:00Z")).rejects.toBeInstanceOf(CalendarAuthError);
  });
});
