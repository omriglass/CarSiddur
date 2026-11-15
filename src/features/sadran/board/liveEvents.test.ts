import { describe, expect, it } from "vitest";

import type { BoardLiveEvent } from "../api";
import { liveEventText, liveEventWhen, newEventCount, visitEvents } from "./liveEvents";

const base: BoardLiveEvent = {
  id: 1, kind: "cancelled", at: "2026-11-18T05:00:00Z", ride_id: null, starts_at: "2026-11-18T06:00:00Z",
  car_name: "יונדאי 1", person_name: "דנה", other_name: null, owner_name: null, names: null,
};

describe("liveEventText (owner wording 2026-11-14)", () => {
  it("one line per kind", () => {
    expect(liveEventText({ ...base, kind: "driver_left" })).toBe("דנה כבר לא נוהג/ת בנסיעה");
    expect(liveEventText({ ...base, kind: "driver_handed", other_name: "יוסי" })).toBe("דנה העביר/ה את הנהיגה ליוסי");
    expect(liveEventText(base)).toBe("דנה ביטל/ה את הנסיעה");
    expect(liveEventText({ ...base, kind: "freed_placed", person_name: "יוסי" })).toBe("יוסי קיבל/ה את הרכב שהתפנה");
    expect(liveEventText({ ...base, kind: "proposal_expired" })).toBe("ההצעה לדנה פגה בלי תשובה");
    // R20H4: a freed car that went to nobody
    expect(liveEventText({ ...base, kind: "freed_none", person_name: null, ends_at: "2026-11-18T10:00:00Z" }))
      .toBe("הרכב שהתפנה (08:00–12:00) לא הוצע לאף אחד: אין בקשה מתאימה");
  });

  it("a join names everyone added in one action and whose ride it is", () => {
    expect(liveEventText({ ...base, kind: "joined", names: ["יוסי"], owner_name: "דנה" })).toBe("יוסי הצטרף/ה לנסיעה של דנה");
    expect(liveEventText({ ...base, kind: "joined", names: ["יוסי", "רון"], owner_name: "דנה" })).toBe("יוסי ו־רון הצטרף/ה לנסיעה של דנה");
    expect(liveEventText({ ...base, kind: "joined", names: ["יוסי"], owner_name: null })).toBe("יוסי הצטרף/ה לנסיעה");
  });
});

describe("liveEventWhen", () => {
  it("day, hour and car", () => {
    expect(liveEventWhen(base)).toBe("ד׳ 18.11 08:00 · יונדאי 1");
    expect(liveEventWhen({ starts_at: base.starts_at, car_name: null })).toBe("ד׳ 18.11 08:00");
  });
});

describe("the visit", () => {
  const events = [{ id: 9 }, { id: 7 }, { id: 4 }];
  it("counts what is after the marker", () => {
    expect(newEventCount(events, 6)).toBe(2);
    expect(newEventCount(events, 9)).toBe(0);
  });
  it("keeps the lines the visit began with after the marker moves", () => {
    expect(visitEvents(events, 6).map((e) => e.id)).toEqual([9, 7]);
  });
});
