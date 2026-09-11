import { z } from "zod";

import { he } from "@/i18n/he";
import { TRIP_SHAPES } from "@/lib/enums";

import type { DestinationValue } from "@/components/DestinationCombobox";
import type { TripShape } from "@/lib/enums";

/**
 * react-hook-form + zod schema for the new/edit request form (UX_FLOWS.md
 * §3.4, REQUIREMENTS §5.1/§5.3/§5.4). Mirrors `submit_request`'s own
 * validation (supabase/migrations/20260907091500_rpc.sql) so the member sees
 * the same rule client-side before the round trip; the RPC remains the final
 * arbiter (CLAUDE.md decision 8).
 */

/** = SQL `trip_shape` (`src/lib/enums.ts`). */
export const REQUEST_TRIP_SHAPES = TRIP_SHAPES;
export type RequestTripShape = TripShape;

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
    /**
     * Multi-day request ("series", REQ §13.77, UX_FLOWS.md §3.4) — `yyyy-MM-dd`, weekly
     * variant + new mode + round trip only. `undefined`/equal to `day` means an ordinary
     * same-day request; a LATER date routes the submit through `submit_series_request`
     * instead of `submit_request` (`RequestForm.tsx`). Left optional (rather than mirroring
     * `day`'s own required+default treatment) so every existing caller/test that never heard
     * of multi-day requests keeps working unchanged.
     */
    returnDay: z.string().optional(),
    destination: destinationValueSchema,
    rideTypeId: z.string().min(1, he.request.rideTypeRequired),
    preferredCarId: z.string().optional(),
    tripShape: z.enum(REQUEST_TRIP_SHAPES),
    departTime: timeStringSchema.optional(),
    returnTime: z.union([timeStringSchema, z.literal("23:59")]).optional(),
    /** Kept for old callers; overnight values are rejected. No UI toggle. */
    returnNextDay: z.boolean(),
    oneWayCarMode: z.enum(ONE_WAY_CAR_MODES).optional(),
    needsCarAtDestination: z.boolean(),
    adults: z.number().int().min(1).max(8),
    childSeats: z.number().int().min(0).max(8),
    boosters: z.number().int().min(0).max(8),
    companions: z.array(z.string()),
    children: z.array(z.string()),
    /** Pre-registry requests can have unnamed child seats; preserve them on edit. */
    legacyChildSeats: z.number().int().min(0).max(8),
    luggage: z.boolean(),
    flexDepartEarly: flexValueSchema,
    flexDepartLate: flexValueSchema,
    flexReturnEarly: flexValueSchema,
    flexReturnLate: flexValueSchema,
    notes: z.string(),
    rideDescription: z.string().trim().max(1000, he.ridePublicDetails.invalidDescription),
    /**
     * Free-text guest passengers, one name per line (`quickRequest.guestPassengers`) — shared
     * by both the weekly and quick variants of `RequestForm` (UX_FLOWS.md §18): named people
     * with no department profile. Parsed with `guestPassengerNames()` (`../quickRequest.ts`)
     * and sent as `guest_passenger_names` alongside `companions`/`children`.
     */
    guestNames: z.string(),
    /**
     * Car-now-variant-only (`RequestForm` `variant="carNow"`, UX_FLOWS.md §18): whole hours,
     * 1–12, default 2 (`../carNow.ts`). Drives `returnTime` (`departTime` + this many hours,
     * capped at 23:59) client-side only — never sent to `submit_request` (`../mapper.ts` only
     * maps `departTime`/`returnTime`), so it needs no SQL counterpart.
     */
    durationHours: z.number().int().min(1).max(12).optional(),
    /**
     * Weekly-variant-only "בקשה חוזרת" switch (UX_FLOWS.md §3.3/§3.4, REQ §76): never sent to
     * `submit_request` — a truthy value drives a follow-up `save_request_template` call, a
     * falsy one (when a template was already linked) a `stop_request_template` call. Not part
     * of `../mapper.ts`'s payload mapping, same pattern as `durationHours` above.
     */
    repeatWeekly: z.boolean(),
  })
  .superRefine((value, ctx) => {
    const needsDepart = value.tripShape !== "one_way_from";
    const needsReturn = value.tripShape !== "one_way_to";
    // A multi-day span's return time is on a later calendar day, so the plain
    // minutes-of-day comparison below (meant to catch same-day return-before-departure
    // typos) does not apply — the RPC itself is the arbiter of the actual span.
    const isMultiDay = value.tripShape === "round_trip" && !!value.returnDay && value.returnDay !== value.day;

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

    if (needsDepart && needsReturn && !isMultiDay && value.departTime && value.returnTime) {
      const departMinutes = timeToMinutes(value.departTime);
      const returnMinutes = timeToMinutes(value.returnTime);
      if (returnMinutes <= departMinutes) {
        ctx.addIssue({
          path: ["returnTime"],
          code: z.ZodIssueCode.custom,
          message: he.request.returnBeforeDeparture,
        });
      }
    }

    if (value.returnNextDay) {
      ctx.addIssue({
        path: ["returnNextDay"],
        code: z.ZodIssueCode.custom,
        message: he.sadranProposal.sameDayOnly,
      });
    }

    const guestLines = value.guestNames
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean);
    if (guestLines.length > 20 || guestLines.some((name) => name.length > 100)) {
      ctx.addIssue({
        path: ["guestNames"],
        code: z.ZodIssueCode.custom,
        message: he.quickRequest.invalidGuestNames,
      });
    }
  });

export type RequestFormValues = z.infer<typeof requestFormSchema>;

export const REQUEST_FORM_DEFAULTS: Omit<RequestFormValues, "departmentId" | "weekStart" | "day" | "dayIndex" | "rideTypeId" | "destination"> = {
  preferredCarId: "",
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
  children: [],
  legacyChildSeats: 0,
  luggage: false,
  flexDepartEarly: 0,
  flexDepartLate: 0,
  flexReturnEarly: 0,
  flexReturnLate: 0,
  notes: "",
  rideDescription: "",
  guestNames: "",
  repeatWeekly: false,
};

/**
 * `v_request_template_suggestions` row (DATA_MODEL.md §3.6, `supabase/migrations/
 * 20260910092000_request_templates_as_suggestions.sql`), validated at the `requests/api.ts`
 * boundary before it reaches the UI. `depart_at`/`return_at` already fall on the suggestion's
 * `week_start` (computed in SQL from `depart_dow`/`depart_time` etc.), so the prefill mapper
 * (`../templatePrefill.ts`) can read them exactly like `RequestEditRow`'s own instants.
 */
export const templateSuggestionRowSchema = z.object({
  template_id: z.string(),
  department_id: z.string(),
  week_start: z.string(),
  destination_id: z.string().nullable(),
  destination_text: z.string().nullable(),
  destination_name: z.string().nullable(),
  ride_type_id: z.string(),
  ride_type_name: z.string().nullable(),
  trip_shape: z.enum(REQUEST_TRIP_SHAPES),
  depart_dow: z.number().nullable(),
  depart_time: z.string().nullable(),
  return_dow: z.number().nullable(),
  return_time: z.string().nullable(),
  depart_at: z.string().nullable(),
  return_at: z.string().nullable(),
  one_way_car_mode: z.enum(ONE_WAY_CAR_MODES).nullable(),
  needs_car_at_destination: z.boolean().nullable(),
  adults: z.number(),
  child_seats: z.number(),
  boosters: z.number(),
  child_ids: z.array(z.string()),
  companion_ids: z.array(z.string()),
  has_luggage: z.boolean().nullable(),
  flex_depart_early: z.string(),
  flex_depart_late: z.string(),
  flex_return_early: z.string(),
  flex_return_late: z.string(),
  preferred_car_id: z.string().nullable(),
  ride_description: z.string().nullable(),
  guest_passenger_names: z.array(z.string()),
  notes: z.string().nullable(),
});

export type TemplateSuggestionRow = z.infer<typeof templateSuggestionRowSchema>;
