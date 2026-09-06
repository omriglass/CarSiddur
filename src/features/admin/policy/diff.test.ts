import { describe, expect, it } from "vitest";

import { computeFlips, computeRankingDelta } from "./diff";

describe("computeRankingDelta", () => {
  it("ranks descending by score, ties broken by id ascending", () => {
    const rows = computeRankingDelta(
      new Map([
        ["b", 5],
        ["a", 5],
        ["c", 3],
      ]),
      new Map([
        ["b", 5],
        ["a", 5],
        ["c", 3],
      ]),
    );
    expect(rows.map((r) => r.requestId)).toEqual(["a", "b", "c"]);
    expect(rows[0]).toMatchObject({ currentRank: 1, newRank: 1, rankDelta: 0 });
  });

  it("computes a positive rankDelta when a request moves up (lower rank number)", () => {
    // current: a=1 (rank1), b=2(rank2); new: b=10(rank1), a=1(rank2) -> a moved down, b moved up
    const rows = computeRankingDelta(
      new Map([
        ["a", 2],
        ["b", 1],
      ]),
      new Map([
        ["a", 1],
        ["b", 10],
      ]),
    );
    const a = rows.find((r) => r.requestId === "a")!;
    const b = rows.find((r) => r.requestId === "b")!;
    expect(a.currentRank).toBe(1);
    expect(a.newRank).toBe(2);
    expect(a.rankDelta).toBe(-1); // moved down one place
    expect(b.currentRank).toBe(2);
    expect(b.newRank).toBe(1);
    expect(b.rankDelta).toBe(1); // moved up one place
  });

  it("sorts rows by the new ranking", () => {
    const rows = computeRankingDelta(
      new Map([
        ["a", 1],
        ["b", 2],
      ]),
      new Map([
        ["a", 10],
        ["b", 1],
      ]),
    );
    expect(rows.map((r) => r.requestId)).toEqual(["a", "b"]);
  });

  it("gives null for a request present on only one side", () => {
    const rows = computeRankingDelta(new Map([["a", 1]]), new Map([["b", 1]]));
    const a = rows.find((r) => r.requestId === "a")!;
    const b = rows.find((r) => r.requestId === "b")!;
    expect(a.newScore).toBeNull();
    expect(a.newRank).toBeNull();
    expect(a.rankDelta).toBeNull();
    expect(b.currentScore).toBeNull();
  });
});

describe("computeFlips", () => {
  it("finds requests that flip from served to unmet and vice versa", () => {
    const flips = computeFlips(new Set(["a", "b"]), new Set(["b", "c"]));
    expect(flips).toEqual([
      { requestId: "a", direction: "servedToUnmet" },
      { requestId: "c", direction: "unmetToServed" },
    ]);
  });

  it("returns an empty array when nothing changes", () => {
    expect(computeFlips(new Set(["a"]), new Set(["a"]))).toEqual([]);
  });
});
