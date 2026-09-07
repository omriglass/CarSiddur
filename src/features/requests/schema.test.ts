import { describe, expect, it } from "vitest";
import { he } from "@/i18n/he";

import { REQUEST_FORM_DEFAULTS, requestFormSchema, type RequestFormValues } from "./schema";

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

describe("requestFormSchema", () => {
  it("accepts a well-formed round-trip request", () => {
    const result = requestFormSchema.safeParse(baseValues());
    expect(result.success).toBe(true);
  });

  it("rejects a return time before the departure time", () => {
    const result = requestFormSchema.safeParse(
      baseValues({ departTime: "13:00", returnTime: "09:00" }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "returnTime")).toBe(true);
    }
  });

  it("accepts a return time before departure when returnNextDay is set", () => {
    const result = requestFormSchema.safeParse(
      baseValues({ departTime: "20:00", returnTime: "07:00", returnNextDay: true }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects returnNextDay on the last day of the week (would leave the target week)", () => {
    const result = requestFormSchema.safeParse(
      baseValues({ day: "2026-09-19", dayIndex: 6, departTime: "20:00", returnTime: "07:00", returnNextDay: true }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "returnNextDay")).toBe(true);
    }
  });

  it("requires oneWayCarMode for a one-way trip shape", () => {
    const result = requestFormSchema.safeParse(
      baseValues({ tripShape: "one_way_to", departTime: "08:00", returnTime: undefined, oneWayCarMode: undefined }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "oneWayCarMode")).toBe(true);
    }
  });

  it("accepts one_way_to with a car mode and no return time", () => {
    const result = requestFormSchema.safeParse(
      baseValues({ tripShape: "one_way_to", departTime: "08:00", returnTime: undefined, oneWayCarMode: "relay" }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts one_way_from with a car mode and no depart time", () => {
    const result = requestFormSchema.safeParse(
      baseValues({ tripShape: "one_way_from", departTime: undefined, returnTime: "12:00", oneWayCarMode: "passenger" }),
    );
    expect(result.success).toBe(true);
  });

  it("requires a depart time for round trips", () => {
    const result = requestFormSchema.safeParse(baseValues({ departTime: undefined }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "departTime")).toBe(true);
    }
  });

  it("accepts every flexibility value on all four flex fields", () => {
    for (const flex of [0, 15, 30, 60, 120, "any"] as const) {
      const result = requestFormSchema.safeParse(
        baseValues({ flexDepartEarly: flex, flexDepartLate: flex, flexReturnEarly: flex, flexReturnLate: flex }),
      );
      expect(result.success).toBe(true);
    }
  });

  it("rejects an out-of-domain flexibility value", () => {
    const result = requestFormSchema.safeParse(baseValues({ flexDepartEarly: 45 as unknown as 0 }));
    expect(result.success).toBe(false);
  });

  it("requires at least one adult", () => {
    const result = requestFormSchema.safeParse(baseValues({ adults: 0 }));
    expect(result.success).toBe(false);
  });

  it("requires a destination (preset or free text)", () => {
    const result = requestFormSchema.safeParse(
      baseValues({ destination: { freeText: "" } as unknown as RequestFormValues["destination"] }),
    );
    expect(result.success).toBe(false);
  });
});


it("identifies a missing ride type with a localized actionable message", () => {
  const result = requestFormSchema.safeParse(baseValues({ rideTypeId: "" }));
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["rideTypeId"], message: he.request.rideTypeRequired }));
  }
});
