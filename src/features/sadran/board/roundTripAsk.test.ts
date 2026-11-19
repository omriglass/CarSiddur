// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { rememberRoundTripAskDeclined, roundTripAsk, roundTripAskDeclined, servedWithBothWays } from "./roundTripAsk";

const HOME = "home";
function ride(over: Record<string, unknown> = {}) {
  return {
    id: "r1", status: "draft", origin_id: HOME, destination_id: HOME, origin_name: "גבעת חביבה",
    ends_at: "2026-11-18T11:30:00Z",
    served: [{ request_id: "q1", role: "passenger", leg: "out", car_mode: "passenger", requester: "טוסיה" }],
    ...over,
  } as never;
}
const roundTrip = { id: "q1", trip_type: "round_trip", return_at: "2026-11-18T11:00:00Z", requester_full_name: "טוסיה" } as never;

describe("roundTripAsk (RT1)", () => {
  it("asks when the ride ends where it started, covers the return hour and the way back is placed nowhere", () => {
    expect(roundTripAsk(ride(), [ride()], [roundTrip])).toMatchObject({
      rideId: "r1", requestId: "q1", kind: "round_trip", name: "טוסיה", originName: "גבעת חביבה",
    });
  });

  it("does not ask when the ride ends before the return hour", () => {
    const r = ride({ ends_at: "2026-11-18T10:00:00Z" });
    expect(roundTripAsk(r, [r], [roundTrip])).toBeNull();
  });

  it("does not ask when the ride ends somewhere else", () => {
    const r = ride({ destination_id: "x" });
    expect(roundTripAsk(r, [r], [roundTrip])).toBeNull();
  });

  it("does not ask when the way back is already placed (here or on another ride)", () => {
    const back = ride({ id: "r2", served: [{ request_id: "q1", role: "passenger", leg: "return", car_mode: "passenger" }] });
    expect(roundTripAsk(ride(), [ride(), back], [roundTrip])).toBeNull();
    const both = ride({ served: [{ request_id: "q1", role: "passenger", leg: "both", car_mode: "passenger" }] });
    expect(roundTripAsk(both, [both], [roundTrip])).toBeNull();
  });

  it("ignores a cancelled ride carrying the way back", () => {
    const back = ride({ id: "r2", status: "cancelled", served: [{ request_id: "q1", role: "passenger", leg: "return", car_mode: "passenger" }] });
    expect(roundTripAsk(ride(), [ride(), back], [roundTrip])).not.toBeNull();
  });

  it("asks the הקפצה variant for a chauffeured drop-off with an unplaced pickup", () => {
    const r = ride({ served: [{ request_id: "q1", role: "passenger", leg: "out", car_mode: "chauffeur", requester: "קטיה" }] });
    const dropOff = { id: "q1", trip_type: "drop_off", return_at: "2026-11-18T11:00:00Z", requester_full_name: "קטיה" } as never;
    expect(roundTripAsk(r, [r], [dropOff])).toMatchObject({ kind: "drop_off", name: "קטיה" });
  });

  it("never asks for a one-way request or one without a return hour", () => {
    expect(roundTripAsk(ride(), [ride()], [{ ...(roundTrip as object), trip_type: "one_way" } as never])).toBeNull();
    expect(roundTripAsk(ride(), [ride()], [{ ...(roundTrip as object), return_at: null } as never])).toBeNull();
  });
});

describe("servedWithBothWays", () => {
  it("turns only that request's way out into both ways, a relay into keep", () => {
    const rows = [
      { request_id: "q1", role: "driver" as const, leg: "out" as const, car_mode: "relay" as const },
      { request_id: "q2", role: "passenger" as const, leg: "out" as const, car_mode: "passenger" as const },
    ];
    expect(servedWithBothWays(rows, "q1")).toEqual([
      { request_id: "q1", role: "driver", leg: "both", car_mode: "keep" },
      { request_id: "q2", role: "passenger", leg: "out", car_mode: "passenger" },
    ]);
  });
});

describe("declined answers", () => {
  beforeEach(() => localStorage.clear());
  it("are remembered for that ride and request only", () => {
    rememberRoundTripAskDeclined({ rideId: "r1", requestId: "q1" });
    expect(roundTripAskDeclined({ rideId: "r1", requestId: "q1" })).toBe(true);
    expect(roundTripAskDeclined({ rideId: "r1", requestId: "q2" })).toBe(false);
  });
});
