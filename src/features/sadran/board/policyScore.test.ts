import { describe, expect, it } from "vitest";
import { baseInput, makeRequest, makeCar, slotMs } from "@/solver/__fixtures__/gen";

import { boardPolicyScore } from "./policyScore";
import type { BoardRide } from "../api";

function ride(served: unknown[], overrides: Partial<BoardRide> = {}): BoardRide {
  return { status: "confirmed", needs_driver: false, served, ...overrides } as unknown as BoardRide;
}

describe("boardPolicyScore", () => {
  it("scores 2 requests, one served, at 0.5 under equal weights", () => {
    const r1 = makeRequest({ id: "r1", memberId: "m1", departureMs: slotMs(32), returnMs: slotMs(40) });
    const r2 = makeRequest({ id: "r2", memberId: "m2", departureMs: slotMs(44), returnMs: slotMs(48) });
    const input = baseInput({
      cars: [makeCar("car")],
      requests: [r1, r2],
      policy: { id: "policy", version: 1, rules: [{ type: "rideType", weight: 1, params: { weights: { other: 1 } } }] },
    });
    const boardRides = [ride([{ request_id: "r1", role: "driver", leg: "both", car_mode: "keep", adults: 1, child_seats: 0, boosters: 0, luggage: false }])];
    expect(boardPolicyScore({ input }, boardRides)).toBe(0.5);
  });

  it("returns null when there is nothing to score", () => {
    const input = baseInput({ cars: [makeCar("car")], requests: [], policy: { id: "policy", version: 1, rules: [] } });
    expect(boardPolicyScore({ input }, [])).toBeNull();
  });

  it("ignores a cancelled or driverless ride's served entries", () => {
    const r1 = makeRequest({ id: "r1", memberId: "m1", departureMs: slotMs(32), returnMs: slotMs(40) });
    const r2 = makeRequest({ id: "r2", memberId: "m2", departureMs: slotMs(44), returnMs: slotMs(48) });
    const input = baseInput({
      cars: [makeCar("car")],
      requests: [r1, r2],
      policy: { id: "policy", version: 1, rules: [{ type: "rideType", weight: 1, params: { weights: { other: 1 } } }] },
    });
    const servedEntry = [{ request_id: "r1", role: "driver", leg: "both", car_mode: "keep", adults: 1, child_seats: 0, boosters: 0, luggage: false }];
    const boardRides = [
      ride(servedEntry, { status: "cancelled" }),
      ride(servedEntry, { needs_driver: true }),
    ];
    expect(boardPolicyScore({ input }, boardRides)).toBe(0);
  });
});
