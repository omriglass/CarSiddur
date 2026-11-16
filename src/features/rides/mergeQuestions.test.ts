import { describe, expect, it } from "vitest";

import { isTightSchedule, longDetourText, parseLongDetour } from "./mergeQuestions";

// REQ item 246 g (owner 2026-11-16): a merge that moves a stop's stated hour is only said ("לו״ז צפוף"), never asked.
describe("mergeQuestions: a stop's stated hour", () => {
  const names = { host: "עומרי", hostPlace: "בנימינה", guest: "דנה", guestPlace: "זכרון יעקב", leg: "return" as const };
  const fixed = { name: "בנימינה", at: "2026-11-19T14:30:00Z", anchor: "arrive", minutes: 12, leg: "return" };

  it("a moved stated hour is a tight schedule, not a question", () => {
    expect(isTightSchedule({ ok: true, fixed_hour: fixed })).toBe(true);
    expect(isTightSchedule({ ok: true, fixed_hour: null })).toBe(false);
    expect(parseLongDetour({ ok: true, detour_waivable: false, fixed_hour: fixed })).toBeNull();
  });

  it("a long detour asks as before, without the hour", () => {
    const detour = parseLongDetour({ detour_waivable: true, added_return_minutes: 40, detour_problem: true, fixed_hour: fixed });
    expect(detour).toEqual({ outMinutes: 0, returnMinutes: 40, unknownHops: [] });
    expect(longDetourText(detour!, names)).not.toContain("16:30");
  });
});
