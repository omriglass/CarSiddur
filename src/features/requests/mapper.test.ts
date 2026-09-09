import { describe, expect, it } from "vitest";

import { flexValueToInterval, intervalToFlexValue, toInstant, toSubmitRequestPayload } from "./mapper";
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

  it("omits needs_car_at_destination's opposite fields for a one-way shape and includes the car mode", () => {
    const payload = toSubmitRequestPayload(
      baseValues({ tripShape: "one_way_to", departTime: "08:00", returnTime: undefined, oneWayCarMode: "relay" }),
    );
    expect(payload.trip_shape).toBe("one_way_to");
    expect(payload.one_way_car_mode).toBe("relay");
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

describe("quick-variant options", () => {
  it("includes guest passenger names only when there are any", () => {
    expect(toSubmitRequestPayload(baseValues(), { guestPassengerNames: ["Guest One"] }).guest_passenger_names).toEqual(["Guest One"]);
    expect(toSubmitRequestPayload(baseValues(), { guestPassengerNames: [] }).guest_passenger_names).toBeUndefined();
    expect(toSubmitRequestPayload(baseValues()).guest_passenger_names).toBeUndefined();
  });

  it("sets reserve_missing_driver only when requested", () => {
    expect(toSubmitRequestPayload(baseValues(), { reserveMissingDriver: true }).reserve_missing_driver).toBe(true);
    expect(toSubmitRequestPayload(baseValues()).reserve_missing_driver).toBeUndefined();
  });
});
