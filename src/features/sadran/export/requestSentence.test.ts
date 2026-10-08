import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";

import { requestSentenceText, type RequestSentenceInput } from "./requestSentence";

const base = {
  trip_type: "round_trip", depart_at: "2026-10-12T14:00:00Z", return_at: "2026-10-12T16:00:00Z", arrive_by: null, leave_dest_at: null,
  depart_anchor: "leave", return_anchor: "arrive", duration_locked: false,
  flex_depart_early: "00:00:00", flex_depart_late: "00:00:00", flex_return_early: "00:00:00", flex_return_late: "00:00:00",
  adults: 1, child_seats: 0, boosters: 0, has_luggage: false, notes: null, ride_description: null, template_id: null,
  fallback: "none", served_by_alternative: false, series_id: null, series_index: null, series_count: null,
  destination_text: null, origin_text: null, requester_full_name: "עומרי גלס", destination_resolved_name: "חיפה", origin_resolved_name: "גבעת חביבה",
} as unknown as RequestSentenceInput;
const plain = (text: string) => text.replace(/[‪‬]/g, "");
const L = (t: string) => `‪${t}‬`;

describe("requestSentenceText", () => {
  it("reads a round trip with anchors, companions, flexibility, car and notes (times kept left-to-right)", () => {
    const text = requestSentenceText({ ...base, companions: [{ profile_id: "p", name: "עומר" }], adults: 2,
      return_anchor: "arrive", flex_depart_early: "00:30:00", flex_depart_late: "00:30:00", flex_return_early: "00:30:00", flex_return_late: "00:30:00",
      preferred_car_name: "יונדאי 2", has_luggage: true, notes: "בבקשה", ride_description: "פגישה" });
    expect(plain(text)).toBe(
      `עומרי גלס ועומר ${he.requestSentence.needsPlural} ${he.request.tripTypeRoundTrip} מגבעת חביבה לחיפה ביום ב׳ 12.10, ${he.requestSentence.anchor.outLeave}17:00, ${he.requestSentence.anchor.returnArrive} 19:00`
      + ` · גמישות ±½ ש׳ · עדיפות לרכב יונדאי 2 · ${he.requestSentence.carLuggage} · ${he.requestSentence.note}: בבקשה · ${he.requestSentence.description}: פגישה`);
    expect(text).toContain(L("17:00"));
    expect(text).toContain(L("19:00"));
  });

  it("uses the arrive-by and leave-there anchors, and the singular verb for one person", () => {
    const text = plain(requestSentenceText({ ...base, depart_anchor: "arrive", arrive_by: "2026-10-12T14:30:00Z", return_anchor: "leave", leave_dest_at: "2026-10-12T15:00:00Z" }));
    expect(text).toContain(he.requestSentence.needs);
    expect(text).not.toContain(he.requestSentence.needsPlural);
    expect(text).toContain(`${he.requestSentence.anchor.outArrive} 17:30`);
    expect(text).toContain(`${he.requestSentence.anchor.returnLeave}18:00`);
  });

  it("states a time window instead of fixed times, and splits asymmetric flexibility only for fixed times", () => {
    const text = plain(requestSentenceText({ ...base, duration_locked: true, depart_at: "2026-10-12T04:00:00Z", return_at: "2026-10-12T07:00:00Z", flex_return_late: "02:00:00" }));
    expect(text).toContain(`${he.requestSentence.window.forPrefix}3 שעות בין 07:00 ל־12:00`.replace("3 שעות", "3 שעות"));
    expect(text).not.toContain(he.requestSentence.anchor.outLeave);
    expect(text).not.toContain("גמישות");
  });

  it("describes a הקפצה with a pickup, unnamed extras and a stop", () => {
    const text = plain(requestSentenceText({ ...base, trip_type: "drop_off", return_anchor: "leave", leave_dest_at: "2026-10-12T16:00:00Z", adults: 3, child_seats: 1,
      stops: [{ leg: "out", position: 1, place_id: "s", place: { name: "כרכור" } }] as RequestSentenceInput["stops"] }));
    expect(text).toContain(he.requestSentence.tripDropOffPickup);
    expect(text).toContain(`מגבעת חביבה ${he.requestSentence.via} כרכור לחיפה`);
    expect(text).toContain("עומרי גלס ועוד 2 מבוגרים וילד/ה");
    expect(text).toContain(`${he.requestSentence.anchor.pickupLeave}19:00`);
  });

  it("appends plan B and marks a multi-day leg", () => {
    const text = plain(requestSentenceText({ ...base, fallback: "alternative",
      alternative: { drop_place_id: null, drop_place_text: "חריש", arrive_by: "2026-10-12T05:00:00Z", pickup: true, pickup_at: "2026-10-12T16:00:00Z", pickup_place_id: null, applied_at: null } as RequestSentenceInput["alternative"] }));
    expect(text).toContain("חריש");
    expect(text).toContain("08:00");
    expect(text).toContain("19:00");
    const series = plain(requestSentenceText({ ...base, series_id: "s", series_index: 2, series_count: 3 }));
    expect(series).toContain("יום 2/3");
  });
});
