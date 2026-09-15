import { describe, expect, it } from "vitest";

import { payloadSeatCounts, serverSeatCountsAfterChildren } from "./seatCounts";

const kid = { isAdultPassenger: false };
const bigKid = { isAdultPassenger: true };

/** The form's two-step write: `submit_request` with the payload counts, then `set_request_children`. */
function roundTrip(input: Parameters<typeof payloadSeatCounts>[0], selected: { isAdultPassenger: boolean }[]) {
  return serverSeatCountsAfterChildren(payloadSeatCounts(input), input.previousChildren, selected);
}

describe("payloadSeatCounts", () => {
  it("a new request with one named child under eight ends with exactly one child seat (the bug: it was two)", () => {
    const input = { companionsCount: 0, guestsCount: 0, legacyChildSeats: 0, previousChildren: [] };
    expect(payloadSeatCounts(input)).toEqual({ adults: 1, childSeats: 0 });
    expect(roundTrip(input, [kid])).toEqual({ adults: 1, childSeats: 1 });
  });

  it("a named child of eight or more becomes one adult seat, once", () => {
    const input = { companionsCount: 1, guestsCount: 0, legacyChildSeats: 0, previousChildren: [] };
    expect(roundTrip(input, [bigKid])).toEqual({ adults: 3, childSeats: 0 });
  });

  it("re-saving with the same child keeps the counts stable", () => {
    const input = { companionsCount: 0, guestsCount: 0, legacyChildSeats: 0, previousChildren: [kid] };
    expect(payloadSeatCounts(input)).toEqual({ adults: 1, childSeats: 1 });
    expect(roundTrip(input, [kid])).toEqual({ adults: 1, childSeats: 1 });
  });

  it("adding a second child on edit adds one seat, removing the child removes it", () => {
    const input = { companionsCount: 0, guestsCount: 0, legacyChildSeats: 0, previousChildren: [kid] };
    expect(roundTrip(input, [kid, kid])).toEqual({ adults: 1, childSeats: 2 });
    expect(roundTrip(input, [])).toEqual({ adults: 1, childSeats: 0 });
  });

  it("unnamed (legacy) child seats and guests survive alongside named children", () => {
    const input = { companionsCount: 0, guestsCount: 2, legacyChildSeats: 1, previousChildren: [] };
    expect(roundTrip(input, [kid])).toEqual({ adults: 3, childSeats: 2 });
  });
});
