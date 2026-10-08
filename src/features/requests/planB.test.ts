import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";

import { fallbackPayload, toSubmitRequestPayload } from "./mapper";
import { defaultPlanB, planBActive, planBFormFields, planBOffered, planBProblems, shiftTime } from "./planB";
import { REQUEST_FORM_DEFAULTS, requestFormSchema, type RequestFormValues } from "./schema";

function values(overrides: Partial<RequestFormValues> = {}): RequestFormValues {
  return {
    ...REQUEST_FORM_DEFAULTS,
    departmentId: "dept-1",
    weekStart: "2026-10-11",
    day: "2026-10-14",
    dayIndex: 3,
    destination: { presetId: "dest-haifa", name: "חיפה" },
    origin: { presetId: "home", name: "בית" },
    rideTypeId: "type-1",
    departTime: "08:00",
    returnTime: "19:00",
    ...overrides,
  } as RequestFormValues;
}

const PLAN_B = { fallback: "alternative", altPlace: { presetId: "harish", name: "צומת חריש" }, altArriveBy: "09:00", altPickup: true, altPickupAt: "19:00" } as const;

describe("planBOffered / planBActive", () => {
  it("is offered for a single-day round trip and a one-way only", () => {
    expect(planBOffered({ tripType: "round_trip", day: "2026-10-14", returnDay: "2026-10-14" })).toBe(true);
    expect(planBOffered({ tripType: "one_way", day: "2026-10-14" })).toBe(true);
    expect(planBOffered({ tripType: "drop_off", day: "2026-10-14" })).toBe(false);
    expect(planBOffered({ tripType: "round_trip", day: "2026-10-14", returnDay: "2026-10-16" })).toBe(false);
  });

  it("is active only for fallback 'alternative'", () => {
    expect(planBActive({ tripType: "round_trip", day: "d", fallback: "alternative" })).toBe(true);
    expect(planBActive({ tripType: "round_trip", day: "d", fallback: "manage" })).toBe(false);
    expect(planBActive({ tripType: "drop_off", day: "d", fallback: "alternative" })).toBe(false);
  });
});

describe("defaults", () => {
  it("arrives by the main departure + 1 h, empty place, pickup at the main return for a round trip", () => {
    expect(defaultPlanB({ tripType: "round_trip", departTime: "08:00", returnTime: "19:00", departAnchor: "leave" })).toEqual({
      altPlace: { freeText: "" },
      altArriveBy: "09:00",
      altPickup: true,
      altPickupAt: "19:00",
    });
  });

  it("a one-way has no pickup by default; a return not after the arrival falls back to +4 h", () => {
    expect(defaultPlanB({ tripType: "one_way", departTime: "08:00", returnTime: undefined, departAnchor: "leave" }).altPickup).toBe(false);
    expect(defaultPlanB({ tripType: "round_trip", departTime: "08:00", returnTime: "08:30", departAnchor: "leave" }).altPickupAt).toBe("13:00");
  });

  it("starts from the arrive-by time when the main trip was entered that way, and stays inside the day", () => {
    expect(defaultPlanB({ tripType: "round_trip", departTime: "08:00", returnTime: "19:00", arriveByTime: "09:30", departAnchor: "arrive" }).altArriveBy).toBe("10:30");
    expect(shiftTime("23:00", 60)).toBe("23:45");
  });
});

describe("planBProblems + schema", () => {
  it("requires place, arrival and a pickup after the arrival", () => {
    expect(planBProblems({ altPlace: { freeText: " " }, altArriveBy: undefined, altPickup: false, altPickupAt: undefined }).map((p) => p.problem)).toEqual(["placeRequired", "arriveRequired"]);
    expect(planBProblems({ ...PLAN_B, altPickupAt: "09:00" }).map((p) => p.problem)).toEqual(["pickupBeforeArrive"]);
    expect(planBProblems({ ...PLAN_B, altPickupAt: undefined }).map((p) => p.problem)).toEqual(["pickupRequired"]);
    expect(planBProblems(PLAN_B)).toEqual([]);
  });

  it("accepts a valid plan B and an empty fallback", () => {
    expect(requestFormSchema.safeParse(values(PLAN_B)).success).toBe(true);
    expect(requestFormSchema.safeParse(values()).success).toBe(true);
    expect(requestFormSchema.safeParse(values({ fallback: "manage" })).success).toBe(true);
  });

  it("flags an incomplete plan B on the right fields", () => {
    const result = requestFormSchema.safeParse(values({ fallback: "alternative", altPlace: { freeText: "" }, altArriveBy: undefined, altPickup: false }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((i) => i.path.join("."))).toEqual(expect.arrayContaining(["altPlace", "altArriveBy"]));
  });

  it("refuses a drop place equal to the origin, by id and by free text", () => {
    for (const [origin, altPlace] of [
      [{ presetId: "home", name: "בית" }, { presetId: "home", name: "בית" }],
      [{ freeText: "Kfar" }, { freeText: " kfar " }],
    ] as const) {
      const result = requestFormSchema.safeParse(values({ ...PLAN_B, origin, altPlace }));
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.path.join(".") === "altPlace");
        expect(issue?.message).toBe(he.planB.error.sameAsOrigin);
      }
    }
  });

  it("does not validate an inactive plan B (drop-off, manage, none)", () => {
    const broken = { altPlace: { freeText: "" }, altArriveBy: undefined } as const;
    expect(requestFormSchema.safeParse(values({ fallback: "alternative", tripType: "drop_off", tripShape: "one_way_to", returnTime: undefined, ...broken })).success).toBe(true);
    expect(requestFormSchema.safeParse(values({ fallback: "manage", ...broken })).success).toBe(true);
  });
});

describe("fallbackPayload / toSubmitRequestPayload", () => {
  it("sends plan B with instants on the main day (Jerusalem)", () => {
    expect(fallbackPayload(values(PLAN_B))).toEqual({
      fallback: "alternative",
      alternative: {
        drop_place_id: "harish",
        arrive_by: "2026-10-14T06:00:00.000Z",
        pickup: true,
        pickup_at: "2026-10-14T16:00:00.000Z",
      },
    });
  });

  it("sends free text, and no pickup when it was removed", () => {
    const payload = fallbackPayload(values({ ...PLAN_B, altPlace: { freeText: " הצומת " }, altPickup: false, altPickupAt: undefined }));
    expect(payload.alternative).toEqual({ drop_place_text: "הצומת", arrive_by: "2026-10-14T06:00:00.000Z", pickup: false, pickup_at: null });
  });

  it("sends a pickup place only when it differs from the drop place and a pickup is on", () => {
    const karkur = { presetId: "karkur", name: "צומת כרכור" } as const;
    expect(fallbackPayload(values({ ...PLAN_B, altPickupPlace: karkur })).alternative).toMatchObject({ pickup_place_id: "karkur" });
    expect(fallbackPayload(values({ ...PLAN_B, altPickupPlace: { freeText: " הצומת " } })).alternative).toMatchObject({ pickup_place_text: "הצומת" });
    expect("pickup_place_id" in fallbackPayload(values({ ...PLAN_B, altPickupPlace: PLAN_B.altPlace })).alternative!).toBe(false);
    expect("pickup_place_id" in fallbackPayload(values({ ...PLAN_B, altPickup: false, altPickupAt: undefined, altPickupPlace: karkur })).alternative!).toBe(false);
  });

  it("refuses a pickup place equal to the origin", () => {
    const result = requestFormSchema.safeParse(values({ ...PLAN_B, altPickupPlace: { presetId: "home", name: "בית" } }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.find((i) => i.path.join(".") === "altPickupPlace")?.message).toBe(he.planB.error.pickupSameAsOrigin);
  });

  it("follows the day when the main day changes (clock times kept)", () => {
    const payload = fallbackPayload(values({ ...PLAN_B, day: "2026-10-15", dayIndex: 4 }));
    expect(payload.alternative?.arrive_by).toBe("2026-10-15T06:00:00.000Z");
    expect(payload.alternative?.pickup_at).toBe("2026-10-15T16:00:00.000Z");
  });

  it("'none' + null when the line was removed; 'manage' also clears a stored plan B", () => {
    expect(fallbackPayload(values())).toEqual({ fallback: "none", alternative: null });
    expect(fallbackPayload(values({ ...PLAN_B, fallback: "none" }))).toEqual({ fallback: "none", alternative: null });
    expect(fallbackPayload(values({ fallback: "manage" }))).toEqual({ fallback: "manage", alternative: null });
  });

  it("sends nothing for a הקפצה or a multi-day request", () => {
    expect(fallbackPayload(values({ ...PLAN_B, tripType: "drop_off" }))).toEqual({});
    expect(fallbackPayload(values({ ...PLAN_B, returnDay: "2026-10-16" }))).toEqual({});
  });

  it("only the weekly sentence form adds the keys (never classic, quick, car-now, series)", () => {
    const v = values(PLAN_B);
    expect(toSubmitRequestPayload(v, { layout: "sentence", planB: true })).toMatchObject({ fallback: "alternative" });
    expect("fallback" in toSubmitRequestPayload(v, { layout: "sentence" })).toBe(false);
    expect("fallback" in toSubmitRequestPayload(v, { layout: "classic", planB: true })).toBe(false);
    expect("fallback" in toSubmitRequestPayload(v, { layout: "sentence", planB: true, isSeries: true })).toBe(false);
    expect("alternative" in toSubmitRequestPayload(v, {})).toBe(false);
  });
});

describe("planBFormFields (edit prefill)", () => {
  const timeOf = (instant: string) => (instant.includes("T06") ? "09:00" : "19:00");
  it("reopens a stored plan B", () => {
    expect(
      planBFormFields(
        { fallback: "alternative", alternative: { dropPlaceId: "harish", dropPlaceText: null, dropPlaceName: "צומת חריש", arriveBy: "2026-10-14T06:00:00Z", pickup: true, pickupAt: "2026-10-14T16:00:00Z", pickupPlaceId: null, pickupPlaceText: null, pickupPlaceName: null } },
        timeOf,
      ),
    ).toEqual({ fallback: "alternative", altPlace: { presetId: "harish", name: "צומת חריש" }, altArriveBy: "09:00", altPickup: true, altPickupAt: "19:00" });
  });

  it("prefills a stored pickup place", () => {
    const fields = planBFormFields({ fallback: "alternative", alternative: { dropPlaceId: "harish", dropPlaceText: null, dropPlaceName: "חריש", arriveBy: "2026-10-14T06:00:00Z", pickup: true, pickupAt: "2026-10-14T16:00:00Z", pickupPlaceId: "karkur", pickupPlaceText: null, pickupPlaceName: "כרכור" } }, timeOf);
    expect(fields.altPickupPlace).toEqual({ presetId: "karkur", name: "כרכור" });
  });

  it("free text, no pickup, and 'none' without a stored plan B", () => {
    expect(planBFormFields({ fallback: "alternative", alternative: { dropPlaceId: null, dropPlaceText: "הצומת", dropPlaceName: "הצומת", arriveBy: "2026-10-14T06:00:00Z", pickup: false, pickupAt: null, pickupPlaceId: null, pickupPlaceText: null, pickupPlaceName: null } }, timeOf)).toMatchObject({ altPlace: { freeText: "הצומת" }, altPickup: false, altPickupAt: undefined });
    expect(planBFormFields({ fallback: "none", alternative: null }, timeOf).fallback).toBe("none");
    expect(planBFormFields({ fallback: "manage", alternative: null }, timeOf).fallback).toBe("manage");
  });
});
