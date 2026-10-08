import { describe, expect, it } from "vitest";

import { extraAdultsFromStored, payloadSeatCounts, serverSeatCountsAfterChildren, unnamedChildSeatsFromStored } from "./seatCounts";

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

describe("unnamed adults (R9B1)", () => {
  it("stored 4 adults with no names: edit prefill gives 3 extras and the save writes 4 again", () => {
    const extra = extraAdultsFromStored({ storedAdults: 4, companionsCount: 0, guestsCount: 0, adultChildrenCount: 0 });
    expect(extra).toBe(3);
    const input = { companionsCount: 0, guestsCount: 0, legacyChildSeats: 0, extraAdults: extra, previousChildren: [] };
    expect(roundTrip(input, [])).toEqual({ adults: 4, childSeats: 0 });
  });

  it("named adults and adult children are subtracted before the unnamed remainder", () => {
    // requester + 1 companion + 1 guest + 1 eight-year-old + 2 unnamed = 6 stored adults
    const extra = extraAdultsFromStored({ storedAdults: 6, companionsCount: 1, guestsCount: 1, adultChildrenCount: 1 });
    expect(extra).toBe(2);
    const input = { companionsCount: 1, guestsCount: 1, legacyChildSeats: 0, extraAdults: extra, previousChildren: [bigKid] };
    expect(roundTrip(input, [bigKid])).toEqual({ adults: 6, childSeats: 0 });
  });

  it("never goes negative, and a plain request has none", () => {
    expect(extraAdultsFromStored({ storedAdults: 1, companionsCount: 2, guestsCount: 0, adultChildrenCount: 0 })).toBe(0);
    expect(extraAdultsFromStored({ storedAdults: 1, companionsCount: 0, guestsCount: 0, adultChildrenCount: 0 })).toBe(0);
  });

  it("a new request adds the extras on top of the requester", () => {
    expect(payloadSeatCounts({ companionsCount: 0, guestsCount: 0, legacyChildSeats: 0, extraAdults: 2, previousChildren: [] })).toEqual({ adults: 3, childSeats: 0 });
  });
});

describe("unnamedChildSeatsFromStored (REQ §13.112 d)", () => {
  it("is the stored child seats minus the named children that use a seat", () => {
    expect(unnamedChildSeatsFromStored({ storedChildSeats: 3, seatChildrenCount: 1 })).toBe(2);
    expect(unnamedChildSeatsFromStored({ storedChildSeats: 1, seatChildrenCount: 1 })).toBe(0);
    expect(unnamedChildSeatsFromStored({ storedChildSeats: 0, seatChildrenCount: 2 })).toBe(0);
  });
  it("round-trips with payloadSeatCounts + serverSeatCountsAfterChildren", () => {
    const named = [{ isAdultPassenger: false }];
    const written = payloadSeatCounts({ companionsCount: 0, guestsCount: 0, legacyChildSeats: 2, previousChildren: [] });
    const stored = serverSeatCountsAfterChildren(written, [], named);
    expect(unnamedChildSeatsFromStored({ storedChildSeats: stored.childSeats, seatChildrenCount: 1 })).toBe(2);
  });
});
