import { describe, expect, it } from "vitest";

import { seriesCarTakenText } from "./seriesCarTaken";

// Wednesday 18.11.2026 08:00 in Jerusalem
const at = "2026-11-18T06:00:00Z";
const base = { latestReturn: "2026-11-18T05:30:00Z", requestedReturn: "2026-11-18T10:00:00Z", editorIsRequester: true };

describe("seriesCarTakenText (MD1)", () => {
  it("names the member who needs the car", () => {
    const text = seriesCarTakenText({ ...base, blocker: { kind: "ride", starts_at: at, ends_at: at, name: "דנה" } });
    expect(text).toBe("דנה צריך/ה את הרכב ביום ד׳ 18.11 בשעה 08:00. להקדים את שעת החזרה או לבטל את השינוי?");
  });
  it("says the car is in maintenance", () => {
    expect(seriesCarTakenText({ ...base, blocker: { kind: "maintenance", starts_at: at, ends_at: at } }))
      .toBe("הרכב בטיפול ביום ד׳ 18.11 מ־08:00. להקדים את שעת החזרה או לבטל את השינוי?");
  });
  it("asks about the member's own ride, in the second person or naming the member", () => {
    const own = { kind: "own_ride" as const, starts_at: at, ends_at: at, name: "דנה", ride_id: "r1" };
    expect(seriesCarTakenText({ ...base, blocker: own }))
      .toBe("יש לך כבר נסיעה ברכב הזה ביום ד׳ 18.11 בשעה 08:00. להחליף אותה בנסיעה הרב־יומית?");
    expect(seriesCarTakenText({ ...base, editorIsRequester: false, blocker: own }))
      .toBe("לדנה כבר יש נסיעה ברכב הזה ביום ד׳ 18.11 בשעה 08:00. להחליף אותה בנסיעה הרב־יומית?");
  });
});
