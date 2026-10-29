import { describe, expect, it } from "vitest";

import type { ServedEntry } from "@/features/rides/servedOf";

import { choiceOf, closeRequestIds, continueRequestIds, nothingLeaves, rideCancelLines } from "./rideCancelChoices";

const entry = (request_id: string | null, role: ServedEntry["role"], requester: string | null, leg: ServedEntry["leg"] = "both"): ServedEntry => ({
  request_id, role, leg, car_mode: role === "driver" ? "keep" : "passenger", adults: 1, child_seats: 0, boosters: 0, luggage: false, requester,
});

describe("rideCancelLines", () => {
  it("lists one line per request, the driver's first", () => {
    const lines = rideCancelLines([entry("q2", "passenger", "Bob"), entry("q1", "driver", "Ann"), entry("q3", "passenger", null)]);
    expect(lines).toEqual([{ requestId: "q1", name: "Ann" }, { requestId: "q2", name: "Bob" }, { requestId: "q3", name: "" }]);
  });

  it("merges a request that rides two legs and skips entries with no request", () => {
    const lines = rideCancelLines([entry("q1", "passenger", "Ann", "out"), entry("q1", "passenger", "Ann", "return"), entry(null, "passenger", "Guest")]);
    expect(lines).toEqual([{ requestId: "q1", name: "Ann" }]);
  });
});

describe("closeRequestIds", () => {
  const lines = [{ requestId: "q1", name: "Ann" }, { requestId: "q2", name: "Bob" }];

  it("keeps a lone request on the waiting list by default", () => {
    const one = [{ requestId: "q1", name: "Ann" }];
    expect(choiceOf({}, "q1", one)).toBe("keep");
    expect(closeRequestIds(one, {})).toEqual([]);
    expect(continueRequestIds(one, {})).toEqual([]);
  });

  it("returns only the requests marked not relevant, in line order", () => {
    expect(closeRequestIds(lines, { q2: "close", q1: "keep" })).toEqual(["q2"]);
    expect(closeRequestIds(lines, { q2: "close", q1: "close" })).toEqual(["q1", "q2"]);
  });

  it("ignores a choice for a request that is not on the ride", () => {
    expect(closeRequestIds(lines, { q9: "close" })).toEqual([]);
  });
});

describe("continueRequestIds (O29-2 (3))", () => {
  const lines = [{ requestId: "q1", name: "Ann" }, { requestId: "q2", name: "Bob" }, { requestId: "q3", name: "Cy" }];

  it("on a merged ride the first request waits and every other one continues by default", () => {
    expect(choiceOf({}, "q1", lines)).toBe("keep");
    expect(choiceOf({}, "q2", lines)).toBe("continue");
    expect(continueRequestIds(lines, {})).toEqual(["q2", "q3"]);
    expect(nothingLeaves(lines, {})).toBe(false);
  });

  it("follows the Sadran's choices and refuses everyone continuing", () => {
    expect(continueRequestIds(lines, { q2: "keep", q3: "close" })).toEqual([]);
    expect(closeRequestIds(lines, { q2: "keep", q3: "close" })).toEqual(["q3"]);
    expect(nothingLeaves(lines, { q1: "continue" })).toBe(true);
  });

  it("never continues a lone request", () => {
    const one = [{ requestId: "q1", name: "Ann" }];
    expect(choiceOf({ q1: "continue" }, "q1", one)).toBe("keep");
    expect(continueRequestIds(one, { q1: "continue" })).toEqual([]);
  });
});
