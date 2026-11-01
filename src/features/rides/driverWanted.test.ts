import { describe, expect, it } from "vitest";

import { driverWantedDay, driverWantedText } from "./driverWanted";
import type { BoardRide } from "./api";

const person = (id: string, name: string) => ({
  key: `requester:${id}`, source: "requester", request_id: "q1", ride_passenger_id: null, person_id: id, child_id: null,
  display_name: name, seat_kind: "adult", added_by: null, removable: true,
});

function ride(overrides: Partial<BoardRide> = {}, leg: "out" | "return" = "out"): BoardRide {
  return {
    id: "r1", starts_at: "2026-11-05T06:00:00Z", ends_at: "2026-11-05T07:00:00Z", origin_id: "home", destination_id: "home",
    destination_name: "נבו", needs_driver: true, status: "flagged",
    served: [{ request_id: "q1", role: "passenger", leg, car_mode: "chauffeur", adults: 1, child_seats: 0, boosters: 0, luggage: false,
      requester: "שלמה מלכיאלי", destination: "בנימינה", origin_id: "home" }],
    people: [person("p1", "שלמה מלכיאלי")],
    ...overrides,
  } as unknown as BoardRide;
}

describe("driverWantedDay", () => {
  const now = new Date("2026-11-01T10:00:00Z"); // Sunday
  it("says today, tomorrow, the weekday, then adds the date", () => {
    expect(driverWantedDay(new Date("2026-11-01T18:00:00Z"), now)).toBe("היום");
    expect(driverWantedDay(new Date("2026-11-02T06:00:00Z"), now)).toBe("מחר");
    expect(driverWantedDay(new Date("2026-11-05T06:00:00Z"), now)).toBe("ביום חמישי");
    expect(driverWantedDay(new Date("2026-11-09T06:00:00Z"), now)).toBe("ביום שני 9.11");
  });
});

describe("driverWantedText (REQ §13.170)", () => {
  const now = new Date("2026-11-01T10:00:00Z");
  it("names the rider for someone else", () => {
    expect(driverWantedText(ride(), "me", now, "https://x/ride/r1"))
      .toBe("היי, צריך שמישהו יקפיץ את שלמה מלכיאלי ביום חמישי לבנימינה, לצאת בשעה 08:00. מי יוכל? https://x/ride/r1");
  });
  it("says אותי when the viewer rides, then the others", () => {
    const text = driverWantedText(ride({ people: [person("p1", "שלמה מלכיאלי"), person("me", "טליה")] } as Partial<BoardRide>), "me", now, "L");
    expect(text).toContain("יקפיץ אותי ואת שלמה מלכיאלי ");
  });
  it("gives a pickup's own time from the route, the driver's start in brackets (R17U1)", () => {
    const route = [{ leg: "return", kind: "origin", position: 0, name: "בנימינה", place_id: "b", place_text: null, request_id: "q1", eta: "2026-11-05T06:40:00Z" }];
    expect(driverWantedText(ride({ route } as Partial<BoardRide>, "return"), "me", now, "L"))
      .toContain("יאסוף את שלמה מלכיאלי ביום חמישי מבנימינה בשעה 08:40 (יציאה מהקיבוץ 08:00)");
  });
  it("words a pickup leg as a pickup from the place", () => {
    expect(driverWantedText(ride({}, "return"), "me", now, "L")).toContain("יאסוף את שלמה מלכיאלי ביום חמישי מבנימינה, לצאת בשעה 08:00");
  });
});
