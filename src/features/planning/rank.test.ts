import { describe, expect, it } from "vitest";

import type { PlanningDay } from "./api";
import { dayLoad, isPlannable, occupancy, rankOptions, type RankContext } from "./rank";

const SETTINGS = { full: 0.8, good: 0.75, weekCost: 0.1, carMultiplier: 1.2 };
const CTX: RankContext = { mode: "reservations", typical: null, settings: SETTINGS };
const TODAY = "2026-10-26"; // a Monday; its week starts 2026-10-25

function day(date: string, reserved: Partial<PlanningDay["reserved"]> = {}, extra: Partial<PlanningDay> = {}): PlanningDay {
  return {
    date, phase: null, available: { m: 4, a: 4, e: 4 }, reserved: { m: 0, a: 0, e: 0, ...reserved },
    rides: 0, requests: 0, reservationIds: [], ...extra,
  };
}

/** Sundays .. Saturdays of the weeks starting 2026-11-08, 11-15, 11-22. */
function weeks(fill: (date: string, dow: number) => Partial<PlanningDay["reserved"]> = () => ({})): PlanningDay[] {
  const out: PlanningDay[] = [];
  for (let i = 0; i < 21; i++) {
    const d = new Date(Date.UTC(2026, 10, 8 + i));
    const date = d.toISOString().slice(0, 10);
    out.push(day(date, fill(date, i % 7)));
  }
  return out;
}

describe("planning/rank", () => {
  it("occupancy counts only the picked parts; whole day = the worst part", () => {
    const d = day("2026-11-10", { m: 3, e: 1 });
    expect(occupancy(d, "e", CTX)).toBe(0.25);
    expect(occupancy(d, "f", CTX)).toBe(0.75);
    expect(dayLoad(d, CTX)).toBe(0.75);
  });

  it("typical mode adds the weekday's usage and divides by cars x multiplier", () => {
    const typical = Array.from({ length: 7 }, () => ({ m: 2.4, a: 0, e: 0 }));
    const ctx: RankContext = { mode: "typical", typical, settings: SETTINGS };
    expect(occupancy(day("2026-11-10", { m: 1 }), "m", ctx)).toBeCloseTo((1 + 2.4) / (4 * 1.2));
  });

  it("no available car is never an option", () => {
    expect(occupancy(day("2026-11-10", {}, { available: { m: 0, a: 4, e: 4 } }), "m", CTX)).toBe(Infinity);
  });

  it("only days of weeks not open yet, after today, are plannable", () => {
    expect(isPlannable(day("2026-11-10"), TODAY)).toBe(true);
    expect(isPlannable(day("2026-11-10", {}, { phase: "open" }), TODAY)).toBe(false);
    expect(isPlannable(day("2026-11-10", {}, { phase: "upcoming" }), TODAY)).toBe(true);
    expect(isPlannable(day("2026-10-26"), TODAY)).toBe(false);
  });

  it("the nearest option under 'good' wins; the next ones follow by weeks ahead", () => {
    const stars = rankOptions(weeks(), { 2: "m" }, "and", CTX, TODAY);
    expect(stars.get("2026-11-10")).toBe(3);
    expect(stars.get("2026-11-17")).toBe(2);
    expect(stars.get("2026-11-24")).toBe(2);
  });

  it("a day at or above 'full' gets no stars; a later emptier week beats a near one above 'good'", () => {
    const stars = rankOptions(weeks((date) => (date === "2026-11-10" ? { m: 4 } : date === "2026-11-17" ? { m: 3.12 } : {})), { 2: "m" }, "and", CTX, TODAY);
    expect(stars.has("2026-11-10")).toBe(false); // 100%: full
    expect(stars.get("2026-11-24")).toBe(2); // 0% two weeks ahead (score 0.3)
    expect(stars.get("2026-11-17")).toBe(3); // 78%: 0.2 + 0.03 = 0.23
  });

  it("'and' puts the same stars on every day of one week; 'or' ranks single days", () => {
    const and = rankOptions(weeks(), { 5: "f", 6: "m" }, "and", CTX, TODAY);
    expect(and.get("2026-11-13")).toBe(3);
    expect(and.get("2026-11-14")).toBe(3);
    const or = rankOptions(weeks((date) => (date === "2026-11-13" ? { m: 2 } : {})), { 5: "f", 6: "m" }, "or", CTX, TODAY);
    expect(or.get("2026-11-14")).toBe(3);
    expect(or.get("2026-11-13")).toBe(2);
  });

  it("nothing picked, nothing marked", () => {
    expect(rankOptions(weeks(), {}, "and", CTX, TODAY).size).toBe(0);
  });

  it("when every option is full, the least full one still gets one star", () => {
    const stars = rankOptions(weeks((date) => ({ m: date === "2026-11-17" ? 3.5 : 4 })), { 2: "m" }, "and", CTX, TODAY);
    expect([...stars.entries()]).toEqual([["2026-11-17", 1]]);
  });

  it("no star at all when no option has a car", () => {
    const noCars = weeks().map((d) => ({ ...d, available: { m: 0, a: 0, e: 0 } }));
    expect(rankOptions(noCars, { 2: "m" }, "and", CTX, TODAY).size).toBe(0);
  });
});
