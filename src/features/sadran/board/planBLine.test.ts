import { describe, expect, it } from "vitest";

import { alternativePlanText, fallbackLine, hasActiveFallback } from "./planBLine";

const alt = { drop_place_id: "p", drop_place_text: null, arrive_by: "2026-10-11T05:00:00.000Z", pickup: true, pickup_at: "2026-10-11T16:00:00.000Z", applied_at: null, drop_place: { name: "צומת חריש" } };

describe("fallback line on the board (REQ §13.112)", () => {
  it("states the plan B with its pickup", () => {
    expect(alternativePlanText(alt)).toBe("הקפצה לצומת חריש עד 08:00, ואיסוף משם ב־19:00");
    expect(fallbackLine({ fallback: "alternative", alternative: alt, trip_type: "round_trip" })).toBe("תוכנית ב׳: הקפצה לצומת חריש עד 08:00, ואיסוף משם ב־19:00");
  });
  it("a plan B without a pickup and with a free-text place", () => {
    expect(alternativePlanText({ ...alt, pickup: false, pickup_at: null, drop_place: null, drop_place_text: "הצומת" })).toBe("הקפצה להצומת עד 08:00");
  });
  it("אסתדר", () => {
    expect(fallbackLine({ fallback: "manage", alternative: null, trip_type: "one_way" })).toBe("אסתדר");
  });
  it("nothing for no fallback, a הקפצה (dormant plan B), a series, or a plan B without its row", () => {
    expect(fallbackLine({ fallback: "none", alternative: alt, trip_type: "round_trip" })).toBeNull();
    expect(fallbackLine({ fallback: "alternative", alternative: alt, trip_type: "drop_off" })).toBeNull();
    expect(fallbackLine({ fallback: "alternative", alternative: alt, trip_type: "round_trip", series_id: "s" })).toBeNull();
    expect(fallbackLine({ fallback: "alternative", alternative: null, trip_type: "round_trip" })).toBeNull();
    expect(hasActiveFallback({ fallback: "manage", trip_type: "drop_off" })).toBe(false);
    expect(hasActiveFallback({ fallback: "manage", trip_type: "round_trip" })).toBe(true);
  });
});

describe("pickup from another place (REQ §13.112 a)", () => {
  it("names the pickup place", () => {
    expect(alternativePlanText({ ...alt, pickup_place: { name: "כרכור" } })).toBe("הקפצה לצומת חריש עד 08:00, ואיסוף מכרכור ב־19:00");
    expect(alternativePlanText({ ...alt, pickup_place_text: "התחנה" })).toBe("הקפצה לצומת חריש עד 08:00, ואיסוף מהתחנה ב־19:00");
  });
});
