import { describe, expect, it } from "vitest";

import type { ServedEntry } from "@/features/rides/servedOf";

import { choiceOf, closeRequestIds, rideCancelLines } from "./rideCancelChoices";

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

  it("keeps everyone on the waiting list by default", () => {
    expect(choiceOf({}, "q1")).toBe("keep");
    expect(closeRequestIds(lines, {})).toEqual([]);
  });

  it("returns only the requests marked not relevant, in line order", () => {
    expect(closeRequestIds(lines, { q2: "close", q1: "keep" })).toEqual(["q2"]);
    expect(closeRequestIds(lines, { q2: "close", q1: "close" })).toEqual(["q1", "q2"]);
  });

  it("ignores a choice for a request that is not on the ride", () => {
    expect(closeRequestIds(lines, { q9: "close" })).toEqual([]);
  });
});
