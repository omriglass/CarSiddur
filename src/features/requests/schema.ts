import { z } from "zod";

import { he } from "@/i18n/he";

import type { DestinationValue } from "@/components/DestinationCombobox";

/**
 * react-hook-form + zod schema for the new/edit request form (UX_FLOWS.md
 * §3.4, REQUIREMENTS §5.1/§5.3/§5.4). Mirrors `submit_request`'s own
 * validation (supabase/migrations/20260907091500_rpc.sql) so the member sees
 * the same rule client-side before the round trip; the RPC remains the final
 * arbiter (CLAUDE.md decision 8).
 */

/** = SQL `trip_shape`. Kept as a local literal union (no `src/lib/enums.ts` yet in this repo). */
export const REQUEST_TRIP_SHAPES = ["round_trip", "one_way_to", "one_way_from"] as const;
export type RequestTripShape = (typeof REQUEST_TRIP_SHAPES)[number];

/** = SQL `leg_car_mode`, restricted to what a member may pick for a one-way leg. */
export const ONE_WAY_CAR_MODES = ["relay", "passenger"] as const;
export type OneWayCarMode = (typeof ONE_WAY_CAR_MODES)[number];

const flexValueSchema = z.union([
  z.literal(0),
  z.literal(15),
  z.literal(30),
  z.literal(60),
  z.literal(120),
  z.literal("any"),
]);

const destinationValueSchema: z.ZodType<DestinationValue> = z.union([
  z.object({ presetId: z.string().min(1), name: z.string().min(1) }),
  z.object({ freeText: z.string().trim().min(1) }),
]);

/** "HH:MM", 15-minute aligned (mirrors `TimeField15`'s own output format). */
const timeStringSchema = z.string().regex(/^([01]\d|2[0-3]):(00|15|30|45)$/);

function timeToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export const requestFormSchema = z
  .object({
    departmentId: z.string().min(1),
    weekStart: z.string().min(1),
    /** `yyyy-MM-dd`, one of the 7 dates of `weekStart`'s week. */
    day: z.string().min(1),
    /** 0 (Sunday) .. 6 (Saturday) — the index of `day` within the target week. */
    dayIndex: z.number().int().min(0).max(6),
    destination: destinationValueSchema,
    rideTypeId: z.string().min(1),
    tripShape: z.enum(REQUEST_TRIP_SHAPES),
    departTime: timeStringSchema.optional(),
    returnTime: timeStringSchema.optional(),
    /** Round trips and `one_way_from`: the return leg lands the day after `day`. */
    returnNextDay: z.boolean(),
    oneWayCarMode: z.enum(ONE_WAY_CAR_MODES).optional(),
    needsCarAtDestination: z.boolean(),
    adults: z.number().int().min(1).max(8),
    childSeats: z.number().int().min(0).max(8),
    boosters: z.number().int().min(0).max(8),
    companions: z.array(z.string()),
    luggage: z.boolean(),
    flexDepartEarly: flexValueSchema,
    flexDepartLate: flexValueSchema,
    flexReturnEarly: flexValueSchema,
    flexReturnLate: flexValueSchema,
    notes: z.string(),
  })
  .superRefine((value, ctx) => {
    const needsDepart = value.tripShape !== "one_way_from";
    const needsReturn = value.tripShape !== "one_way_to";

    if (value.tripShape !== "round_trip" && !value.oneWayCarMode) {
      ctx.addIssue({
        path: ["oneWayCarMode"],
        code: z.ZodIssueCode.custom,
        message: he.errors.oneWayCarModeRequired,
      });
    }

    if (needsDepart && !value.departTime) {
      ctx.addIssue({ path: ["departTime"], code: z.ZodIssueCode.custom, message: he.field.depart });
    }
    if (needsReturn && !value.returnTime) {
      ctx.addIssue({ path: ["returnTime"], code: z.ZodIssueCode.custom, message: he.field.return });
    }

    if (needsDepart && needsReturn && value.departTime && value.returnTime) {
      const departMinutes = timeToMinutes(value.departTime);
      const returnMinutes = timeToMinutes(value.returnTime) + (value.returnNextDay ? 24 * 60 : 0);
      if (returnMinutes <= departMinutes) {
        ctx.addIssue({
          path: ["returnTime"],
          code: z.ZodIssueCode.custom,
          message: he.request.returnBeforeDeparture,
        });
      }
    }

    // A round trip's (or one_way_from's) return landing after Saturday is a blocking
    // error for members (UX_FLOWS §3.4; REQUIREMENTS §5.3, §13.62 — only a Sadran/Admin
    // filing on behalf may pass it, out of this stage's "on behalf" scope).
    if (needsReturn && value.returnNextDay && value.dayIndex === 6) {
      ctx.addIssue({
        path: ["returnNextDay"],
        code: z.ZodIssueCode.custom,
        message: he.request.weekEndBlockingError,
      });
    }
  });

export type RequestFormValues = z.infer<typeof requestFormSchema>;

export const REQUEST_FORM_DEFAULTS: Omit<RequestFormValues, "departmentId" | "weekStart" | "day" | "dayIndex" | "rideTypeId" | "destination"> = {
  tripShape: "round_trip",
  departTime: "08:00",
  returnTime: "12:00",
  returnNextDay: false,
  oneWayCarMode: undefined,
  needsCarAtDestination: true,
  adults: 1,
  childSeats: 0,
  boosters: 0,
  companions: [],
  luggage: false,
  flexDepartEarly: 0,
  flexDepartLate: 0,
  flexReturnEarly: 0,
  flexReturnLate: 0,
  notes: "",
};
