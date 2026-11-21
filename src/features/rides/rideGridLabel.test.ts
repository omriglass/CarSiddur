import { describe, expect, it } from "vitest";

import type { BoardRide } from "./api";
import { rideCardLabel } from "./rideGridLabel";
import { riderShortNames, shortNames } from "./ridePeople";
import { mayBeComplex } from "./useRideSummaries";

const HOME = "home";
const person = (key: string, source: string, name: string, leg = "both") => ({
  key, source, request_id: source === "added" ? null : "q1", ride_passenger_id: null, person_id: null, child_id: null,
  display_name: name, seat_kind: "adult", added_by: null, removable: source !== "driver", leg,
});
const pt = (leg: "out" | "return", position: number, place: string, kind: string) => ({ leg, position, place_id: place, name: place, kind });
const ROUND = [pt("out", 0, HOME, "origin"), pt("out", 1, "bin", "destination"), pt("return", 0, "bin", "destination"), pt("return", 1, HOME, "origin")];
function ride(over: Record<string, unknown> = {}): BoardRide {
  return {
    id: "r1", driver_id: "d", driver_name: "חבר ראשון", origin_id: HOME, destination_id: HOME, origin_name: "נבו", destination_name: "נבו",
    route: ROUND, notes: null, needs_driver: false,
    served: [{ request_id: "q1", role: "driver", leg: "both", car_mode: "keep", requester: "חבר ראשון", destination: "בנימינה",
      destination_id: "bin", trip_type: "round_trip", adults: 3, child_seats: 0, boosters: 0, guest_passenger_names: ["נגה", "ענבר"] }],
    people: [person("driver:d", "driver", "חבר ראשון"), person("guest:q1:1", "guest", "נגה"), person("guest:q1:2", "guest", "ענבר")],
    ...over,
  } as unknown as BoardRide;
}

describe("RP1 ride card title (owner 2026-11-21)", () => {
  it("a simple ride names everyone on it, so the card needs no people line", () => {
    expect(rideCardLabel(ride(), HOME)).toEqual({ label: "חבר, נגה וענבר לבנימינה", namesEveryone: true });
  });

  it("unnamed seats keep the people line", () => {
    const withUnnamed = ride({ served: [{ ...(ride().served as unknown as Record<string, unknown>[])[0], adults: 4 }] });
    expect(rideCardLabel(withUnnamed, HOME).namesEveryone).toBe(false);
  });

  it("a complex ride's flow sentence is its title", () => {
    expect(rideCardLabel(ride(), HOME, { summary: "חבר ונגה יוצאים מהבית לבנימינה. בחזור: …" }))
      .toEqual({ label: "חבר ונגה יוצאים מהבית לבנימינה. בחזור: …", namesEveryone: true });
  });

  it("names: first names unless two share one", () => {
    expect(shortNames(["דנה כהן", "דנה לוי", "חבר ראשון"])).toEqual(["דנה כהן", "דנה לוי", "חבר"]);
    expect(riderShortNames(ride())).toEqual(["חבר", "נגה", "ענבר"]);
  });

  it("only rides that can be complex are read: places in the middle, or both ways with more than one person", () => {
    expect(mayBeComplex(ride())).toBe(true);
    expect(mayBeComplex(ride({ people: [person("driver:d", "driver", "חבר ראשון")] }))).toBe(false);
    expect(mayBeComplex(ride({ route: ROUND.slice(0, 2) }))).toBe(false);
    expect(mayBeComplex(ride({ route: [ROUND[0], pt("out", 1, "zic", "stop"), { ...ROUND[1], position: 2 }], people: [person("driver:d", "driver", "חבר")] }))).toBe(true);
  });
});
