import { describe, expect, it } from "vitest";

import type { RoutePoint } from "@/lib/rideRoute";

import type { BoardRide } from "./api";
import { legSeatSum, maybeShort, seatsMissing, seatsShortLabel, stretchShortfall } from "./seatShortfall";

// REQ item 248 (owner 2026-11-17): a member's edit saves even with more people than seats, and the ride says so.
const five = [{ car_id: "c1", adults: 5, child_seats: 0, boosters: 0 }, { car_id: "c1", adults: 4, child_seats: 1, boosters: 0 }];
const served = (adults: number, leg: "both" | "out" | "return" = "both", role: "driver" | "passenger" = "driver") =>
  ({ request_id: `q${adults}${leg}${role}`, role, leg, car_mode: "keep", adults, child_seats: 0, boosters: 0, luggage: false });
const added = (key: string, leg: "both" | "out" | "return" = "both", seat_kind = "adult") => ({
  key: `added:${key}`, source: "added", request_id: null, ride_passenger_id: key, person_id: null, child_id: null,
  display_name: key, seat_kind, added_by: "x", removable: true, leg,
});
function ride(over: Record<string, unknown> = {}): BoardRide {
  return { id: "r1", car_id: "c1", status: "confirmed", driver_id: "d", served: [], people: [], ...over } as unknown as BoardRide;
}

describe("seat shortfall", () => {
  it("the best seat configuration decides how many seats are missing", () => {
    expect(seatsMissing({ adults: 5, childSeats: 0, boosters: 0 }, five)).toBe(0);
    expect(seatsMissing({ adults: 7, childSeats: 0, boosters: 0 }, five)).toBe(2);
    expect(seatsMissing({ adults: 5, childSeats: 1, boosters: 0 }, five)).toBe(1);
    expect(seatsMissing({ adults: 9, childSeats: 0, boosters: 0 }, [])).toBeNull();
  });

  it("the sum per direction: requests' own seats, people added on the ride, a driver without a request", () => {
    const r = ride({ served: [served(3), served(1, "out", "passenger")], people: [added("a"), added("b", "return")] });
    expect(legSeatSum(r, "out")).toEqual({ adults: 5, childSeats: 0, boosters: 0 });
    expect(legSeatSum(r, "return")).toEqual({ adults: 5, childSeats: 0, boosters: 0 });
    // a volunteer driver has no request of their own: one more seat
    expect(legSeatSum(ride({ served: [served(5, "both", "passenger")] }), "out")?.adults).toBe(6);
    expect(legSeatSum(ride({ driver_id: null }), "out")).toBeNull();
  });

  it("only a ride whose sum is over the seats is checked further; a cancelled ride never", () => {
    expect(maybeShort(ride({ served: [served(5)] }), five)).toBe(false);
    expect(maybeShort(ride({ served: [served(5)], people: [added("a")] }), five)).toBe(true);
    expect(maybeShort(ride({ status: "cancelled", served: [served(9)] }), five)).toBe(false);
  });

  it("the server's per-stretch count names the worst stretch, with its places only when the ride has middle places", () => {
    const pt = (leg: "out" | "return", position: number, name: string): RoutePoint =>
      ({ leg, position, placeId: name, placeText: null, name, requestId: "q", kind: "stop", eta: null });
    const route = [pt("out", 0, "נבו"), pt("out", 1, "בנימינה"), pt("out", 2, "חיפה"), pt("return", 0, "חיפה"), pt("return", 1, "נבו")];
    const leg = (short: number[]) => ({ spans: {}, absent: [], free: short.map(() => 0), short });
    expect(stretchShortfall({ out: leg([0, 0]), return: leg([0]) }, route)).toBeNull();
    expect(stretchShortfall({ out: leg([0, 2]), return: leg([1]) }, route)).toEqual({ n: 2, leg: "out", from: "בנימינה", to: "חיפה" });
    expect(stretchShortfall({ out: leg([0, 0]), return: leg([1]) }, route)).toEqual({ n: 1, leg: "return", from: null, to: null });
    // an older server without `short`: no warning
    expect(stretchShortfall({ out: { spans: {}, absent: [], free: [0, 0] } }, route)).toBeNull();
  });

  it("one seat and many are worded apart", () => {
    const words = { one: "one", many: (n: number) => `many ${n}` };
    expect(seatsShortLabel({ n: 1, leg: "out", from: null, to: null }, words)).toBe("one");
    expect(seatsShortLabel({ n: 3, leg: "out", from: null, to: null }, words)).toBe("many 3");
    expect(seatsShortLabel(null, words)).toBeUndefined();
  });
});
