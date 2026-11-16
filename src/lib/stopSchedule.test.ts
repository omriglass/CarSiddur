import { describe, expect, it } from "vitest";

import cases from "../../supabase/tests/fixtures/stop_schedule_cases.json";

import { carWindow, insertOptions, schedule, type InsertOption, type SchedulePoint, type ScheduleOptions } from "./stopSchedule";

const hm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const travelMap = new Map<string, number>();
for (const [a, b, m] of cases.travel as [string, string, number][]) { travelMap.set(`${a}|${b}`, m); travelMap.set(`${b}|${a}`, m); }
const options: ScheduleOptions = { travel: (a, b) => travelMap.get(`${a}|${b}`) ?? 60, stopMinutes: cases.stopMinutes, defaultStart: hm("08:00") };

type CasePoint = { key: string; place: string; kind: string; stay?: number; fixed?: { anchor: string; at: string; flex: number } };
const toPoints = (ps: CasePoint[]): SchedulePoint[] => ps.map((p) => ({
  key: p.key, place: p.place, kind: p.kind as SchedulePoint["kind"], stay: p.stay ?? null,
  fixed: p.fixed ? { anchor: p.fixed.anchor as "arrive" | "leave", at: hm(p.fixed.at), flex: p.fixed.flex } : null,
}));

describe("stopSchedule — shared cases (SQL twin: request_schedule)", () => {
  for (const c of cases.cases as { name: string; points: CasePoint[]; expect: Record<string, unknown> }[]) {
    it(c.name, () => {
      const s = schedule(toPoints(c.points), options);
      const byKey = new Map(s.points.map((p) => [p.key, p]));
      const e = c.expect as { times?: Record<string, [string, string]>; stays?: Record<string, number>; early?: Record<string, number>; flexUsed?: Record<string, number>; conflict?: unknown; needsReturnHour?: boolean };
      for (const [k, [arr, lv]] of Object.entries(e.times ?? {})) {
        expect([byKey.get(k)?.arrive, byKey.get(k)?.leave], k).toEqual([hm(arr), hm(lv)]);
      }
      for (const [k, m] of Object.entries(e.stays ?? {})) expect(byKey.get(k)?.stay, k).toBe(m);
      for (const [k, m] of Object.entries(e.early ?? {})) expect(byKey.get(k)?.early, k).toBe(m);
      for (const [k, m] of Object.entries(e.flexUsed ?? {})) expect(byKey.get(k)?.flexUsed, k).toBe(m);
      if ("conflict" in e) expect(s.conflict).toEqual(e.conflict);
      if ("needsReturnHour" in e) expect(s.needsReturnHour).toBe(e.needsReturnHour);
    });
  }
});

describe("insertOptions (owner 2026-11-16: before or after Metzer)", () => {
  const exampleB = toPoints(cases.cases[1]!.points as CasePoint[]);
  const exampleA = toPoints(cases.cases[2]!.points as CasePoint[]);
  const gh: SchedulePoint = { key: "gh", place: "גבעת חביבה", kind: "stop", stay: null, fixed: null };

  it("example B: before school uses 5 of the 15 flexible minutes (home 5 later), after school = home 15 later", () => {
    const [first, second] = insertOptions(exampleB, "return", gh, options) as [InsertOption, InsertOption];
    expect(first.beforeIndex).toBe(4);
    expect(first.flexUsed).toEqual([{ key: "school2", minutes: 5 }]);
    expect(first.homeLater).toBe(5);
    expect(first.newArrive).toBe(hm("16:20"));
    expect(second.beforeIndex).toBe(5);
    expect(second.homeLater).toBe(15);
    expect(second.flexUsed).toEqual([]);
  });

  it("example A: before school takes 10 minutes of the worked-out time at work, nothing fixed moves", () => {
    const [first] = insertOptions(exampleA, "return", gh, options) as [InsertOption];
    expect(first.beforeIndex).toBe(4);
    expect(first.destLeaveEarlier).toBe(10);
    expect(first.homeLater).toBe(0);
    expect(first.schedule.points.find((p) => p.key === "school2")?.arrive).toBe(hm("16:30"));
  });

  it("an option past the flexibility is not ok and sorts last", () => {
    const exact = exampleB.map((p) => (p.key === "school2" ? { ...p, fixed: { ...p.fixed!, flex: 0 } } : p));
    const opts = insertOptions(exact, "return", gh, options);
    expect(opts.map((o) => o.ok)).toEqual([true, false]);
    expect(opts[1]?.schedule.conflict).toEqual({ key: "school2", lateBy: 5 });
  });

  it("on the way out: leaving home earlier, the smaller change first", () => {
    const es: SchedulePoint = { key: "es", place: "עין שמר", kind: "stop", stay: null, fixed: null };
    const [first, second] = insertOptions(exampleB, "out", es, options) as [InsertOption, InsertOption];
    expect([first.beforeIndex, first.departEarlier]).toEqual([2, 10]);
    expect([second.beforeIndex, second.departEarlier]).toEqual([1, 20]);
  });

  it("a given stay may be shortened to price an option (always listed)", () => {
    // leave work 15:40 fixed, Ein Shemer with a given 30-minute stay, school 16:30 exactly
    const fixedBack = exampleB.map((p) =>
      p.key === "back" ? { ...p, fixed: { anchor: "leave" as const, at: hm("15:40"), flex: 0 } }
      : p.key === "school2" ? { ...p, fixed: { ...p.fixed!, flex: 0 } } : p);
    const stayed: SchedulePoint[] = [...fixedBack.slice(0, 4), { key: "shop", place: "עין שמר", kind: "stop", stay: 30, fixed: null }, ...fixedBack.slice(4)];
    expect(schedule(stayed, options).conflict).toEqual({ key: "school2", lateBy: 10 });
    const priced = schedule(stayed, { ...options, allowShrink: true });
    expect(priced.conflict).toBeNull();
    expect(priced.points.find((p) => p.key === "shop")?.shortenedBy).toBe(10);
  });

  it("carWindow is the first departure and the last arrival", () => {
    expect(carWindow(schedule(exampleB, options))).toEqual({ start: hm("09:10"), end: hm("16:55") });
  });
});
