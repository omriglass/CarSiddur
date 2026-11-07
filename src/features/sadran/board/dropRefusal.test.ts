import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";
import { AppError } from "@/lib/rpc";

import { describeObstacle, findObstacle, type CarBlock } from "./dropRefusal";

const at = (hhmm: string) => `2026-11-10T${hhmm}:00+02:00`;
const block = (start: string, end: string, name: string, isDraft = false): CarBlock => ({ startsAt: at(start), endsAt: at(end), name, isDraft });
const window = { startsAt: at("06:30"), endsAt: at("13:45") };

describe("findObstacle", () => {
  it("returns null when the car is free", () => {
    expect(findObstacle(window, [block("16:00", "18:00", "A")], 30)).toBeNull();
  });
  it("finds a real overlap and prefers it over a turnaround clash", () => {
    const found = findObstacle(window, [block("14:00", "15:00", "Near"), block("10:00", "11:00", "Inside")], 30);
    expect(found).toMatchObject({ name: "Inside", turnaroundOnly: false });
  });
  it("flags a draft starting inside the turnaround gap after the window", () => {
    const found = findObstacle(window, [block("14:00", "16:00", "Noni", true)], 30);
    expect(found).toMatchObject({ name: "Noni", isDraft: true, turnaroundOnly: true });
  });
  it("back-to-back is free without a turnaround", () => {
    expect(findObstacle(window, [block("13:45", "15:00", "A")], 0)).toBeNull();
  });
});

describe("describeObstacle", () => {
  const err = (code: "ride_overlap" | "ride_seats") => new AppError(code, "x");
  it("names a draft with its start time", () => {
    const line = describeObstacle(err("ride_overlap"), findObstacle(window, [block("10:00", "12:00", "Noni", true)], 30));
    expect(line).toBe("יש טיוטה של Noni על הרכב ב־10:00");
  });
  it("names a ride with its window", () => {
    const line = describeObstacle(err("ride_overlap"), findObstacle(window, [block("10:00", "12:00", "Dana")], 30));
    expect(line).toBe("Dana נוסע/ת ברכב ב־10:00–12:00");
  });
  it("mentions the turnaround gap", () => {
    const line = describeObstacle(err("ride_overlap"), findObstacle(window, [block("14:00", "15:00", "Dana")], 30));
    expect(line).toContain("אין מספיק זמן בין הנסיעות");
  });
  it("keeps the per-code message for other codes or no obstacle", () => {
    expect(describeObstacle(err("ride_seats"), findObstacle(window, [block("10:00", "12:00", "A")], 30))).toBeNull();
    expect(describeObstacle(err("ride_overlap"), null)).toBeNull();
    expect(he.rideEditing.seats).toBeTruthy();
  });
});
