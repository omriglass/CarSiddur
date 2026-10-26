import { describe, expect, it } from "vitest";

import { eventsByDay } from "./monthBlocks";

const base = { calendarId: "c", allDay: false } as const;

describe("calendar/monthBlocks", () => {
  it("a timed event is one block on its day, however long", () => {
    const map = eventsByDay([{ ...base, id: "a", title: "Dentist", start: "2026-11-10T06:00:00Z", end: "2026-11-10T15:00:00Z" }]);
    expect([...map.keys()]).toEqual(["2026-11-10"]);
  });

  it("an all-day event over three days shows on each of them, not on the day after", () => {
    const map = eventsByDay([{ ...base, id: "b", title: "Trip", allDay: true, start: "2026-11-11T22:00:00Z", end: "2026-11-14T22:00:00Z" }]);
    expect([...map.keys()]).toEqual(["2026-11-12", "2026-11-13", "2026-11-14"]);
  });
});
