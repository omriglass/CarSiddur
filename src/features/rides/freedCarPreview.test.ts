import { describe, expect, it, vi } from "vitest";

import { previewFreedCar } from "./api";
import { fetchFreedCarLine, freedCarOutcomeLine, joinFreedNames, type MissedFreedCarPreview } from "./freedCarPreview";

vi.mock("./api", () => ({ previewFreedCar: vi.fn() }));
vi.mock("@/features/diagnostics/reportClientError", () => ({ reportClientError: vi.fn() }));

describe("joinFreedNames", () => {
  it("joins with ו־ or או", () => {
    expect(joinFreedNames(["דנה"], "and")).toBe("דנה");
    expect(joinFreedNames(["דנה", "רון"], "and")).toBe("דנה ו־רון");
    expect(joinFreedNames(["דנה", "רון", "יעל"], "or")).toBe("דנה, רון או יעל");
    expect(joinFreedNames(["דנה", "דנה", " "], "or")).toBe("דנה");
  });
});

describe("freedCarOutcomeLine (owner wording 2026-11-14)", () => {
  it("one person gets the car", () => {
    expect(freedCarOutcomeLine({ kind: "auto", requestId: "r", name: "דנה" })).toBe("בעקבות השינוי דנה יקבל/תקבל את הרכב בשעות האלה. תודה!");
  });
  it("a discussion", () => {
    expect(freedCarOutcomeLine({ kind: "group", requestIds: ["a", "b"], names: ["דנה", "רון"] })).toBe("דנה ו־רון ייכנסו לדיון על הרכב. תודה!");
  });
  it("the Sadran decides", () => {
    expect(freedCarOutcomeLine({ kind: "sadran", requestIds: ["a", "b"], names: ["דנה", "רון"] }))
      .toBe("בעקבות השינוי, דנה או רון יקבלו את הרכב, בהתייעצות עם הסדרן/ית. תודה!");
    expect(freedCarOutcomeLine({ kind: "sadran", requestIds: ["a"], names: ["דנה"] }))
      .toBe("בעקבות השינוי, דנה יקבל/תקבל את הרכב, בהתייעצות עם הסדרן/ית. תודה!");
  });
  it("nobody waiting: no line", () => {
    expect(freedCarOutcomeLine({ kind: "none" })).toBeNull();
    expect(freedCarOutcomeLine({ kind: "held" })).toBeNull();
  });
});

describe("fetchFreedCarLine budget (review 2026-11-15)", () => {
  const request = { action: "cancel_ride" as const, args: {} };
  it("an answer in time is not reported", async () => {
    vi.mocked(previewFreedCar).mockResolvedValue([]);
    const missed: MissedFreedCarPreview[] = [];
    expect(await fetchFreedCarLine(request, 50, (m) => missed.push(m))).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(missed).toEqual([]);
  });
  it("an answer past the budget shows nothing and is recorded with its real time", async () => {
    vi.mocked(previewFreedCar).mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve([]), 60)));
    const missed: MissedFreedCarPreview[] = [];
    expect(await fetchFreedCarLine(request, 10, (m) => missed.push(m))).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(missed).toHaveLength(1);
    expect(missed[0]).toMatchObject({ action: "cancel_ride", hadLine: false });
    expect(missed[0]?.ms).toBeGreaterThanOrEqual(50);
  });
});
