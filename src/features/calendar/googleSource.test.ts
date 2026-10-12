import { describe, expect, it, vi } from "vitest";

import { CalendarAuthError, createGoogleCalendarSource, firstDescriptionLine, toCalendarEvent } from "./googleSource";

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

describe("toCalendarEvent extras", () => {
  const base = { id: "e", start: { dateTime: "2026-10-12T09:00:00Z" }, end: { dateTime: "2026-10-12T10:00:00Z" } };

  it("maps location, attendees (no self / rooms), first description line and colors", () => {
    const event = toCalendarEvent(
      { ...base, summary: "Sync", location: " Room 4 ", description: "<p>Agenda &amp; notes</p><p>second</p>", colorId: "5", attendees: [{ displayName: "Dana", email: "d@x.com" }, { email: "r@x.com" }, { email: "me@x.com", self: true }, { displayName: "Room", resource: true }] },
      "cal",
      { calendar: "#111111", palette: { "5": "#fbd75b" } },
    );
    expect(event).toMatchObject({ location: "Room 4", attendees: ["Dana", "r@x.com"], description: "Agenda & notes", color: "#fbd75b" });
  });

  it("falls back to the calendar color and omits empty extras", () => {
    const event = toCalendarEvent({ ...base, description: "  \n ", attendees: [] }, "cal", { calendar: "#222222", palette: {} });
    expect(event?.color).toBe("#222222");
    expect(event).not.toHaveProperty("description");
    expect(event).not.toHaveProperty("attendees");
    expect(event).not.toHaveProperty("location");
  });

  it("firstDescriptionLine strips tags and picks the first non-empty line", () => {
    expect(firstDescriptionLine("<br><b>Hello</b><br>world")).toBe("Hello");
    expect(firstDescriptionLine("\n\n plain \nsecond")).toBe("plain");
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
    expect(fetchImpl.mock.calls.some((call) => String(call[0]).includes("singleEvents=true"))).toBe(true);
  });

  it("colors events from the event palette, else the calendar's backgroundColor", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/colors")) return jsonResponse({ event: { "9": { background: "#5484ed" } } });
      if (url.includes("/users/me/calendarList/")) return jsonResponse({ backgroundColor: "#039be5" });
      return jsonResponse({ items: [
        { id: "a", summary: "A", start: { dateTime: "2026-10-12T17:00:00Z" }, end: { dateTime: "2026-10-12T18:00:00Z" }, colorId: "9" },
        { id: "b", summary: "B", start: { dateTime: "2026-10-12T17:00:00Z" }, end: { dateTime: "2026-10-12T18:00:00Z" } },
      ] });
    });
    const source = createGoogleCalendarSource("tok", fetchImpl as unknown as typeof fetch);
    const events = await source.listEvents(["mine"], "2026-10-10T00:00:00Z", "2026-10-19T00:00:00Z");
    expect(events.map((e) => e.color)).toEqual(["#5484ed", "#039be5"]);
    await source.listEvents(["mine"], "2026-10-10T00:00:00Z", "2026-10-19T00:00:00Z");
    expect(fetchImpl.mock.calls.filter((call) => String(call[0]).includes("/colors"))).toHaveLength(1);
  });

  it("ignores a failing colors request", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/colors") || url.includes("/users/me/calendarList/")) return jsonResponse({}, 500);
      return jsonResponse({ items: [{ id: "a", summary: "A", colorId: "9", start: { dateTime: "2026-10-12T17:00:00Z" }, end: { dateTime: "2026-10-12T18:00:00Z" } }] });
    });
    const source = createGoogleCalendarSource("tok", fetchImpl as unknown as typeof fetch);
    const events = await source.listEvents(["mine"], "2026-10-10T00:00:00Z", "2026-10-19T00:00:00Z");
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty("color");
  });

  it("turns 401 into CalendarAuthError", async () => {
    const source = createGoogleCalendarSource("expired", vi.fn().mockResolvedValue(jsonResponse({}, 401)));
    await expect(source.listEvents(["mine"], "2026-10-10T00:00:00Z", "2026-10-19T00:00:00Z")).rejects.toBeInstanceOf(CalendarAuthError);
  });
});
