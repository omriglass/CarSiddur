import { describe, expect, it } from "vitest";

import { he, tv } from "@/i18n/he";

import { longDetourText, parseLongDetour } from "./mergeQuestions";

// REQ item 246 g (LT1 phase 2c): a merge that moves a stop's stated hour is asked like a long detour.
describe("mergeQuestions: a stop's stated hour", () => {
  const names = { host: "עומרי", hostPlace: "בנימינה", guest: "דנה", guestPlace: "זכרון יעקב", leg: "return" as const };
  const fixed = { name: "בנימינה", at: "2026-11-19T14:30:00Z", anchor: "arrive", minutes: 12, leg: "return" };

  it("only the hour moves: the question names the place, the hour and the minutes", () => {
    const detour = parseLongDetour({ detour_waivable: true, added_return_minutes: 12, detour_problem: false, fixed_hour: fixed });
    expect(detour?.fixedHour).toEqual({ name: "בנימינה", at: fixed.at, minutes: 12 });
    expect(longDetourText(detour!, names)).toBe(`${tv("mergedRide.fixedHourMoves", { place: "בנימינה", time: "16:30", minutes: "12" })} ${he.mergedRide.fixedHourMergeAnyway}`);
  });

  it("a long detour that also moves the hour says both", () => {
    const text = longDetourText(parseLongDetour({ detour_waivable: true, added_return_minutes: 40, detour_problem: true, fixed_hour: fixed })!, names);
    expect(text).toContain(tv("mergedRide.fixedHourMoves", { place: "בנימינה", time: "16:30", minutes: "12" }));
    expect(text.startsWith(tv("mergedRide.longDetourBody", { ride: tv("mergedRide.longDetourRide", { name: "עומרי", place: "בנימינה" }),
      stop: tv("mergedRide.longDetourPickup", { name: "דנה", place: "זכרון יעקב" }), minutes: "40" }))).toBe(true);
  });

  it("no stated hour: as before", () => {
    expect(parseLongDetour({ detour_waivable: true, added_out_minutes: 30, detour_problem: true })?.fixedHour).toBeNull();
  });
});
