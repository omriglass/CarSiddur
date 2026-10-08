import { describe, expect, it } from "vitest";

import { editReturnInstant, flexValueToInterval, intervalToFlexValue, toInstant, toSubmitRequestPayload } from "./mapper";
import { REQUEST_FORM_DEFAULTS, type RequestFormValues } from "./schema";

// What Postgres echoes back (`select '15 min'::interval` etc.) for each literal
// `flexValueToInterval` sends — not the same string, since Postgres normalizes
// interval literals to `HH:MM:SS` (or keeps the day component for '1 day').
const POSTGRES_ECHO: Record<string, string> = {
  0: "00:00:00",
  15: "00:15:00",
  30: "00:30:00",
  60: "01:00:00",
  120: "02:00:00",
  any: "1 day",
};

describe("flexValueToInterval / intervalToFlexValue", () => {
  it("sends the documented interval literal for every flex value (DATA_MODEL §5.1)", () => {
    expect(flexValueToInterval(0)).toBe("0");
    expect(flexValueToInterval(15)).toBe("15 min");
    expect(flexValueToInterval(30)).toBe("30 min");
    expect(flexValueToInterval(60)).toBe("1 hour");
    expect(flexValueToInterval(120)).toBe("2 hours");
    expect(flexValueToInterval("any")).toBe("1 day");
  });

  it("round-trips every flex value through Postgres's echoed interval text", () => {
    for (const value of [0, 15, 30, 60, 120, "any"] as const) {
      const echoed = POSTGRES_ECHO[value];
      expect(echoed).toBeDefined();
      expect(intervalToFlexValue(echoed as string)).toBe(value);
    }
  });

  it("maps '1 day' to the 'any' sentinel", () => {
    expect(intervalToFlexValue("1 day")).toBe("any");
  });
});

describe("toInstant", () => {
  it("combines a day and time into an Asia/Jerusalem instant", () => {
    const instant = toInstant("2026-09-15", "08:00", false);
    // 08:00 Asia/Jerusalem in September (IDT, UTC+3) is 05:00 UTC.
    expect(instant).toBe("2026-09-15T05:00:00.000Z");
  });

  it("rolls over to the next day when nextDay is set", () => {
    const instant = toInstant("2026-09-15", "01:00", true);
    expect(instant).toBe("2026-09-15T22:00:00.000Z");
  });
});

function baseValues(overrides: Partial<RequestFormValues> = {}): RequestFormValues {
  return {
    ...REQUEST_FORM_DEFAULTS,
    departmentId: "dept-1",
    weekStart: "2026-09-13",
    day: "2026-09-15",
    dayIndex: 2,
    destination: { presetId: "dest-1", name: "חיפה" },
    origin: { freeText: "" },
    rideTypeId: "type-1",
    ...overrides,
  } as RequestFormValues;
}

describe("toSubmitRequestPayload", () => {
  it("maps a round-trip form to the submit_request payload shape", () => {
    const payload = toSubmitRequestPayload(baseValues());
    expect(payload.department_id).toBe("dept-1");
    expect(payload.destination_id).toBe("dest-1");
    expect(payload.destination_text).toBeUndefined();
    expect(payload.trip_shape).toBe("round_trip");
    expect(payload.depart_at).toBe("2026-09-15T05:00:00.000Z");
    expect(payload.return_at).toBe("2026-09-15T09:00:00.000Z");
    expect(payload.one_way_car_mode).toBeUndefined();
    expect(payload.needs_car_at_destination).toBe(true);
  });

  it("sends trip_type straight through and an empty origin as neither origin_id nor origin_text (REQ §13.93)", () => {
    const payload = toSubmitRequestPayload(baseValues({ tripType: "round_trip" }));
    expect(payload.trip_type).toBe("round_trip");
    expect(payload.origin_id).toBeUndefined();
    expect(payload.origin_text).toBeUndefined();
  });

  it("maps an explicit origin preset/free-text onto origin_id/origin_text", () => {
    expect(toSubmitRequestPayload(baseValues({ origin: { presetId: "origin-1", name: "כפר סבא" } })).origin_id).toBe("origin-1");
    expect(toSubmitRequestPayload(baseValues({ origin: { freeText: "איפשהו" } })).origin_text).toBe("איפשהו");
  });

  it("omits needs_car_at_destination's opposite fields for a one-way shape and never sends a car mode (REQ §88 — the server decides it)", () => {
    const payload = toSubmitRequestPayload(
      baseValues({ tripShape: "one_way_to", departTime: "08:00", returnTime: undefined, oneWayCarMode: "relay" }),
    );
    expect(payload.trip_shape).toBe("one_way_to");
    expect(payload.one_way_car_mode).toBeUndefined();
    expect(payload.return_at).toBeUndefined();
  });

  it("passes free-text destinations through as destination_text", () => {
    const payload = toSubmitRequestPayload(baseValues({ destination: { freeText: "מקום כלשהו" } }));
    expect(payload.destination_id).toBeUndefined();
    expect(payload.destination_text).toBe("מקום כלשהו");
  });

  it("forwards request_id/expected_version/join_ride_id options", () => {
    const payload = toSubmitRequestPayload(baseValues(), {
      requestId: "req-1",
      expectedVersion: 3,
      joinRideId: "ride-1",
    });
    expect(payload.request_id).toBe("req-1");
    expect(payload.expected_version).toBe(3);
    expect(payload.join_ride_id).toBe("ride-1");
  });
});


it("persists an optional preferred car and explicitly clears it when removed", () => {
  expect(toSubmitRequestPayload(baseValues({ preferredCarId: "car-1" })).preferred_car_id).toBe("car-1");
  expect(toSubmitRequestPayload(baseValues({ preferredCarId: "" }), { requestId: "request-1", expectedVersion: 2 }).preferred_car_id).toBeNull();
});

describe("multi-day (series) requests", () => {
  it("puts return_at on returnDay instead of day when it is set and later", () => {
    const payload = toSubmitRequestPayload(baseValues({ returnDay: "2026-09-17", returnTime: "12:00" }));
    expect(payload.depart_at).toBe("2026-09-15T05:00:00.000Z");
    expect(payload.return_at).toBe("2026-09-17T09:00:00.000Z");
  });

  it("ignores returnDay when it equals day (an ordinary same-day request)", () => {
    const payload = toSubmitRequestPayload(baseValues({ returnDay: "2026-09-15" }));
    expect(payload.return_at).toBe("2026-09-15T09:00:00.000Z");
  });
});

describe("stops (REQ §13.93 'Multi-stop rides')", () => {
  it("always sends the stops key, even empty, so an edit can clear a previously-added stop", () => {
    expect(toSubmitRequestPayload(baseValues()).stops).toEqual([]);
  });

  it("maps outStops/returnStops onto the payload in leg/route order, preset and free-text alike", () => {
    const payload = toSubmitRequestPayload(
      baseValues({
        outStops: [{ presetId: "binyamina-dest", name: "בנימינה" }, { freeText: "עצירה חופשית" }],
        returnStops: [{ presetId: "hadera-dest", name: "חדרה" }],
      }),
    );
    expect(payload.stops).toEqual([
      { leg: "out", place_id: "binyamina-dest" },
      { leg: "out", place_text: "עצירה חופשית" },
      { leg: "return", place_id: "hadera-dest" },
    ]);
  });

  it("still sends the held return stops for a one-way-to leg (REQ §13.97: the server keeps them inactive)", () => {
    const payload = toSubmitRequestPayload(
      baseValues({
        tripShape: "one_way_to",
        departTime: "08:00",
        returnTime: undefined,
        returnStops: [{ presetId: "hadera-dest", name: "חדרה" }],
      }),
    );
    expect(payload.stops).toEqual([{ leg: "return", place_id: "hadera-dest" }]);
  });
});

describe("quick-variant options", () => {
  it("includes guest passenger names only when there are any", () => {
    expect(toSubmitRequestPayload(baseValues(), { guestPassengerNames: ["Guest One"] }).guest_passenger_names).toEqual(["Guest One"]);
    expect(toSubmitRequestPayload(baseValues(), { guestPassengerNames: [] }).guest_passenger_names).toBeUndefined();
    expect(toSubmitRequestPayload(baseValues()).guest_passenger_names).toBeUndefined();
  });

  it("sets reserve_missing_driver only when requested", () => {
    expect(toSubmitRequestPayload(baseValues(), { reserveMissingDriver: true }).reserve_missing_driver).toBe(true);
  });

  it("a quick one-way reservation is always a passenger leg (submit_request refuses any other mode)", () => {
    const oneWay = { ...baseValues(), tripShape: "one_way_to" as const };
    expect(toSubmitRequestPayload(oneWay, { reserveMissingDriver: true }).one_way_car_mode).toBe("passenger");
    expect(toSubmitRequestPayload(oneWay, {}).one_way_car_mode).toBeUndefined();
    expect(toSubmitRequestPayload(baseValues()).reserve_missing_driver).toBeUndefined();
  });
});

describe("editReturnInstant (UX_FLOWS §3.4)", () => {
  it("prefers return_at, falls back to the kept return time of a one-way request", () => {
    expect(editReturnInstant({ returnAt: "2026-09-13T14:00:00Z", keptReturnAt: "2026-09-13T15:00:00Z" })).toBe("2026-09-13T14:00:00Z");
    expect(editReturnInstant({ returnAt: null, keptReturnAt: "2026-09-13T15:00:00Z" })).toBe("2026-09-13T15:00:00Z");
    expect(editReturnInstant({ returnAt: null })).toBeNull();
  });
});

describe("toSubmitRequestPayload stops (REQ §13.97)", () => {
  it("sends both legs' stops even for a one-way request", () => {
    const values = {
      ...REQUEST_FORM_DEFAULTS,
      departmentId: "dept-1",
      weekStart: "2026-09-13",
      day: "2026-09-15",
      dayIndex: 2,
      destination: { presetId: "dest-1", name: "x" },
      tripShape: "one_way_to",
      tripType: "one_way",
      departTime: "08:00",
      returnTime: "17:00",
      outStops: [{ presetId: "o1", name: "o" }],
      returnStops: [{ presetId: "r1", name: "r" }],
    } as unknown as RequestFormValues;
    const payload = toSubmitRequestPayload(values);
    expect(payload.stops).toEqual([
      { leg: "out", place_id: "o1" },
      { leg: "return", place_id: "r1" },
    ]);
    expect(payload.return_at).toBeUndefined();
  });
});

describe("toSubmitRequestPayload anchors (REQ §13.110 b)", () => {
  const anchored = baseValues({
    departAnchor: "arrive",
    arriveByTime: "09:30",
    departTime: "08:45",
    returnAnchor: "leave",
    leaveDestTime: "13:00",
    returnTime: "13:45",
  });

  it("sends the four anchor keys only for the sentence layout", () => {
    const sentence = toSubmitRequestPayload(anchored, { layout: "sentence" });
    expect(sentence.depart_anchor).toBe("arrive");
    expect(sentence.arrive_by).toBe(toInstant("2026-09-15", "09:30", false));
    expect(sentence.return_anchor).toBe("leave");
    expect(sentence.leave_dest_at).toBe(toInstant("2026-09-15", "13:00", false));
    // depart_at / return_at stay the (derived) car times.
    expect(sentence.depart_at).toBe(toInstant("2026-09-15", "08:45", false));
    expect(sentence.return_at).toBe(toInstant("2026-09-15", "13:45", false));

    const classic = toSubmitRequestPayload(anchored, { layout: "classic" });
    for (const key of ["depart_anchor", "arrive_by", "return_anchor", "leave_dest_at"]) expect(key in classic).toBe(false);
    expect("depart_anchor" in toSubmitRequestPayload(anchored)).toBe(false);
  });

  it("sends explicit nulls for the default anchors so an edit clears the stored times", () => {
    const payload = toSubmitRequestPayload(baseValues(), { layout: "sentence" });
    expect(payload).toMatchObject({ depart_anchor: "leave", arrive_by: null, return_anchor: "arrive", leave_dest_at: null });
  });

  it("never sends a leave-there time for a trip without a return", () => {
    const payload = toSubmitRequestPayload({ ...anchored, tripShape: "one_way_to", tripType: "one_way" }, { layout: "sentence" });
    expect(payload.leave_dest_at).toBeNull();
    expect(payload.arrive_by).not.toBeNull();
  });

  it("omits the anchors for a multi-day series (its legs share one payload)", () => {
    expect("arrive_by" in toSubmitRequestPayload(anchored, { layout: "sentence", isSeries: true })).toBe(false);
  });

  it("puts leave_dest_at on the return day of a multi-day request", () => {
    const payload = toSubmitRequestPayload({ ...anchored, returnDay: "2026-09-16" }, { layout: "sentence" });
    expect(payload.leave_dest_at).toBe(toInstant("2026-09-16", "13:00", false));
  });
});

describe("toSubmitRequestPayload time window (REQ §13.112 c)", () => {
  const windowed = baseValues({ timeMode: "window", windowHours: 4, windowStart: "07:00", windowEnd: "12:00", departTime: "09:00", returnTime: "10:00" });

  it("stores the earliest block, later-only slack on both ends, default anchors and the lock", () => {
    const payload = toSubmitRequestPayload(windowed, { layout: "sentence" });
    expect(payload.duration_locked).toBe(true);
    expect(payload.depart_at).toBe(toInstant("2026-09-15", "07:00", false));
    expect(payload.return_at).toBe(toInstant("2026-09-15", "11:00", false));
    expect(payload).toMatchObject({
      flex_depart_early: "0", flex_return_early: "0", flex_depart_late: "01:00:00", flex_return_late: "01:00:00",
      depart_anchor: "leave", arrive_by: null, return_anchor: "arrive", leave_dest_at: null,
    });
  });

  it("keeps the fixed-mode times untouched in the form (switching modes never loses them)", () => {
    expect(windowed.departTime).toBe("09:00");
    const fixed = toSubmitRequestPayload({ ...windowed, timeMode: "fixed" }, { layout: "sentence" });
    expect(fixed.duration_locked).toBe(false);
    expect(fixed.depart_at).toBe(toInstant("2026-09-15", "09:00", false));
    expect(fixed.flex_depart_late).toBe("0");
  });

  it("sends an explicit false in fixed mode so an edit back to fixed hours clears the lock", () => {
    expect(toSubmitRequestPayload(baseValues(), { layout: "sentence" }).duration_locked).toBe(false);
  });

  it("the classic layout sends no lock key at all (the server keeps the stored lock)", () => {
    expect("duration_locked" in toSubmitRequestPayload(windowed, { layout: "classic" })).toBe(false);
    expect("duration_locked" in toSubmitRequestPayload(windowed)).toBe(false);
  });

  it("is never a window for a multi-day series, a one-way or a הקפצה", () => {
    expect("duration_locked" in toSubmitRequestPayload(windowed, { layout: "sentence", isSeries: true })).toBe(false);
    expect(toSubmitRequestPayload({ ...windowed, tripType: "one_way", tripShape: "one_way_to" }, { layout: "sentence" }).duration_locked).toBe(false);
    expect(toSubmitRequestPayload({ ...windowed, tripType: "drop_off" }, { layout: "sentence" }).duration_locked).toBe(false);
  });

  it("an invalid window (too short) is not sent as one", () => {
    expect(toSubmitRequestPayload({ ...windowed, windowHours: 6 }, { layout: "sentence" }).duration_locked).toBe(false);
  });
});
