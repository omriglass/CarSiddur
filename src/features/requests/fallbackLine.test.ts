import { describe, expect, it } from "vitest";

import { originalRequestLine, planBRecapLine, servedByAlternativeLine, waitingFallbackLine } from "./fallbackLine";

import type { StoredAlternative } from "./planB";

const alt: StoredAlternative = {
  dropPlaceId: "harish",
  dropPlaceText: null,
  dropPlaceName: "צומת חריש",
  arriveBy: "2026-10-14T05:00:00Z", // 08:00 Jerusalem (IDT)
  pickup: true,
  pickupAt: "2026-10-14T16:00:00Z", pickupPlaceId: null, pickupPlaceText: null, pickupPlaceName: null, // 19:00
};

describe("waitingFallbackLine", () => {
  it("shows plan B with and without a pickup", () => {
    expect(waitingFallbackLine({ status: "waitlisted", fallback: "alternative", alternative: alt })).toBe("תוכנית ב׳: הקפצה לצומת חריש עד 08:00 · איסוף ב־19:00");
    expect(waitingFallbackLine({ status: "submitted", fallback: "alternative", alternative: { ...alt, pickup: false, pickupAt: null, pickupPlaceId: null, pickupPlaceText: null, pickupPlaceName: null } })).toBe("תוכנית ב׳: הקפצה לצומת חריש עד 08:00");
  });

  it("shows 'אסתדר' for manage and nothing for none", () => {
    expect(waitingFallbackLine({ status: "submitted", fallback: "manage" })).toBe("אם אין רכב: אסתדר");
    expect(waitingFallbackLine({ status: "submitted", fallback: "none" })).toBeNull();
  });

  it("is hidden once the request has a car, was served by plan B, or is closed", () => {
    expect(waitingFallbackLine({ status: "assigned", fallback: "alternative", alternative: alt })).toBeNull();
    expect(waitingFallbackLine({ status: "waitlisted", fallback: "alternative", alternative: alt, servedByAlternative: true })).toBeNull();
    expect(waitingFallbackLine({ status: "withdrawn", fallback: "manage" })).toBeNull();
  });
});

describe("pickup from another place", () => {
  const other = { ...alt, pickupPlaceId: "karkur", pickupPlaceName: "צומת כרכור" };
  it("names the pickup place in /my, the served line and the recap (twin of SQL alt.pickup_from)", () => {
    expect(waitingFallbackLine({ status: "waitlisted", fallback: "alternative", alternative: other })).toBe("תוכנית ב׳: הקפצה לצומת חריש עד 08:00 · איסוף מצומת כרכור ב־19:00");
    expect(servedByAlternativeLine(other)).toBe("שובצת בתוכנית ב׳: הקפצה לצומת חריש עד 08:00, איסוף מצומת כרכור ב־19:00");
    expect(planBRecapLine({ fallback: "alternative", altArriveBy: "08:00", altPickup: true, altPickupAt: "19:00" }, "צומת חריש", "צומת כרכור")).toBe("אם אין רכב: הקפצה לצומת חריש עד 08:00, ואיסוף מצומת כרכור ב־19:00");
  });
});

describe("servedByAlternativeLine", () => {
  it("names the place for the drop and the pickup", () => {
    expect(servedByAlternativeLine(alt)).toBe("שובצת בתוכנית ב׳: הקפצה לצומת חריש עד 08:00, איסוף מצומת חריש ב־19:00");
    expect(servedByAlternativeLine({ ...alt, pickup: false, pickupAt: null, pickupPlaceId: null, pickupPlaceText: null, pickupPlaceName: null })).toBe("שובצת בתוכנית ב׳: הקפצה לצומת חריש עד 08:00");
  });
});

describe("originalRequestLine", () => {
  const main = { trip_type: "round_trip", destination_id: "haifa", destination_text: null, depart_at: "2026-10-14T05:00:00Z", return_at: "2026-10-14T16:00:00Z" };
  it("rebuilds the replaced request from original_main with the department's names", () => {
    expect(originalRequestLine(main, { destinationName: (id) => (id === "haifa" ? "חיפה" : undefined) })).toBe("הבקשה המקורית: הלוך-חזור לחיפה ד׳ 14.10 08:00–19:00");
  });

  it("one-way shows one time, free text destination is used as is, garbage gives null", () => {
    expect(originalRequestLine({ ...main, trip_type: "one_way", destination_id: null, destination_text: "קיסריה", return_at: null }, { destinationName: () => undefined })).toBe("הבקשה המקורית: הלוך בלבד לקיסריה ד׳ 14.10 08:00");
    expect(originalRequestLine(null, { destinationName: () => undefined })).toBeNull();
    expect(originalRequestLine({ nope: 1 }, { destinationName: () => undefined })).toBeNull();
  });
});

describe("planBRecapLine", () => {
  it("words the stage-2 recap", () => {
    expect(planBRecapLine({ fallback: "alternative", altArriveBy: "08:00", altPickup: true, altPickupAt: "19:00" }, "צומת חריש")).toBe("אם אין רכב: הקפצה לצומת חריש עד 08:00 ואיסוף משם ב־19:00");
    expect(planBRecapLine({ fallback: "alternative", altArriveBy: "08:00", altPickup: false }, "צומת חריש")).toBe("אם אין רכב: הקפצה לצומת חריש עד 08:00");
    expect(planBRecapLine({ fallback: "manage" }, "")).toBe("אם אין רכב: אסתדר");
    expect(planBRecapLine({ fallback: "none" }, "")).toBeNull();
    expect(planBRecapLine({}, "")).toBeNull();
  });
});
