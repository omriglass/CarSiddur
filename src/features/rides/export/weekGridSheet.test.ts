import { describe, expect, it } from "vitest";

import type { BoardRide } from "../api";
import { buildWeekGridSheet } from "./weekGridSheet";

const base = { department_id: "d", week_start: "2026-10-11", status: "confirmed", notes: "n", served: [] };
// 2026-10-11 is a Sunday; Jerusalem is UTC+3 in October (until the end of the month).
const ride = (id: string, car: string, from: string, to: string) => ({ ...base, id, car_id: car, starts_at: from, ends_at: to }) as unknown as BoardRide;
const cars = [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "p", name: "P", type: "temporary" }];

function rangeCells(ref: string): { c1: number; r1: number; c2: number; r2: number } {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref)!;
  const col = (s: string) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  return { c1: col(m[1]!), r1: Number(m[2]), c2: col(m[3]!), r2: Number(m[4]) };
}

describe("week grid sheet", () => {
  const rides = [
    ride("1", "a", "2026-10-11T05:05:00Z", "2026-10-11T06:50:00Z"), // 08:05-09:50 -> 08:00..10:00 (8 rows)
    ride("2", "a", "2026-10-11T06:00:00Z", "2026-10-11T07:00:00Z"), // overlaps in car a -> second lane
    ride("3", "b", "2026-10-12T07:00:00Z", "2026-10-12T08:00:00Z"), // Monday
  ];
  const sheet = buildWeekGridSheet(rides, cars, "2026-10-11", "d");

  it("stacks seven days, hides idle private cars, freezes the car-names row and 2 columns", () => {
    const titles = sheet.rows.filter((r) => r[0] && typeof r[0] === "object" && "style" in r[0] && r[0].style === "title" && r[0].text);
    expect(titles).toHaveLength(7);
    const flat = sheet.rows.flat().map((c) => (c && typeof c === "object" && "text" in c ? c.text : null));
    expect(flat).not.toContain("P");
    expect(sheet.freezeRows).toBe(1);
    expect(sheet.freezeCols).toBe(2);
    expect(sheet.autoFilter).toBe(false);
    // day letters spell ראשון down the first and last column
    const first = sheet.rows.map((r) => (r[0] as { text: string | null } | null)?.text).filter(Boolean) as string[];
    expect(first.slice(1, 6).join("")).toBe("ראשון");
  });

  it("makes one merged block per ride covering its snapped rows, with no overlapping merges", () => {
    const merges = sheet.merges!.map(rangeCells);
    for (let i = 0; i < merges.length; i++) for (let j = i + 1; j < merges.length; j++) {
      const a = merges[i]!, b = merges[j]!;
      expect(a.c1 <= b.c2 && b.c1 <= a.c2 && a.r1 <= b.r2 && b.r1 <= a.r2).toBe(false);
    }
    const spans = merges.filter((m) => m.c1 === m.c2).map((m) => m.r2 - m.r1 + 1);
    expect(spans).toContain(8); // 08:00-10:00
    expect(spans).toContain(4); // 09:00-10:00 and Monday 10:00-11:00
    // car A got a second lane for the overlap -> header merged over 2 columns
    expect(merges.some((m) => m.r1 === m.r2 && m.c2 - m.c1 === 1)).toBe(true);
  });
});
