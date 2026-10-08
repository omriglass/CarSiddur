import { z } from "zod";

import { he } from "@/i18n/he";
import { carTypeSchema, requestFallbackSchema, TRIP_SHAPES, TRIP_TYPES, timeAnchorSchema, tripTypeSchema } from "@/lib/enums";

import type { DestinationValue } from "@/components/DestinationCombobox";
import type { TripShape, TripType } from "@/lib/enums";

import { hasAltPlace, planBActive, planBProblems, type MainTripSnapshot } from "./planB";
import { windowModeActive, windowProblem } from "./timeWindow";

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

/** = SQL `trip_type` (`src/lib/enums.ts`) — the member-facing control (REQ §13.93). */
export const REQUEST_TRIP_TYPES = TRIP_TYPES;
export type RequestTripType = TripType;

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

/**
 * REQ §13.93: unlike `destination`, an unresolved origin (`{ freeText: "" }`, the placeholder
 * `RequestForm.tsx` starts from before its own render-body sync picks the member's real
 * default) is a valid, submittable value — `mapper.ts` sends neither `origin_id` nor
 * `origin_text` for it, and `submit_request` resolves its own default server-side. Validation
 * must never block a submit on a default that genuinely has not resolved yet (e.g. a slow
 * department/destinations fetch).
 */
const originValueSchema: z.ZodType<DestinationValue> = z.union([
  z.object({ presetId: z.string().min(1), name: z.string() }),
  z.object({ freeText: z.string() }),
]);

/** "HH:MM", 15-minute aligned (mirrors `TimeField15`'s own output format). */
const timeStringSchema = z.string().regex(/^([01]\d|2[0-3]):(00|15|30|45)$/);

/** Same list place, or the same free text (trimmed, case-insensitive). An empty free text matches nothing. */
export function isSamePlace(a: DestinationValue, b: DestinationValue): boolean {
  if ("presetId" in a && "presetId" in b) return a.presetId === b.presetId;
  if ("freeText" in a && "freeText" in b) {
    const left = a.freeText.trim().toLowerCase();
    return left !== "" && left === b.freeText.trim().toLowerCase();
  }
  return false;
}

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
    /**
     * REQ §13.93: the request's origin (list place or free text), shown as "מ<place> אל" above
     * the destination. Defaults to the requester's `department_members.default_origin_id` for
     * this department, else the department home (`RequestForm.tsx` resolves the default;
     * `submit_request` re-resolves it server-side when omitted, so an empty value here is never
     * actually sent — see `mapper.ts`).
     */
    origin: originValueSchema,
    /**
     * REQ §13.93 "Multi-stop rides": waypoints on the way out (origin → stop → … →
     * destination), chip-added via `StopsField` — collapsed behind one "+ עצירה" link so the
     * form stays compact. `mapper.ts` always sends the `stops` key (even `[]`) so an edit can
     * clear a previously-added stop.
     */
    outStops: z.array(destinationValueSchema).max(10),
    /** Same shape, destination → stop → … → origin — only shown/submittable when the trip has a return. */
    returnStops: z.array(destinationValueSchema).max(10),
    rideTypeId: z.string().min(1, he.request.rideTypeRequired),
    preferredCarId: z.string().optional(),
    tripShape: z.enum(REQUEST_TRIP_SHAPES),
    /**
     * REQ §13.93: the member-facing three-option control (הלוך-חזור / הלוך בלבד / הקפצה) —
     * the only field `TripTypeFields` writes to directly; it also keeps `tripShape`/
     * `needsCarAtDestination`/`oneWayCarMode` in sync (`tripType.ts`'s `tripTypeToLegacyFields`)
     * so every other consumer of those legacy fields (validation, duplicate detection, the
     * quick-window math, time-field visibility) is unaffected by this addition.
     */
    tripType: z.enum(REQUEST_TRIP_TYPES),
    /** "הקפצה" optional pickup leg ("צריך/ה גם איסוף") — only meaningful when `tripType === "drop_off"`. */
    dropOffPickup: z.boolean(),
    departTime: timeStringSchema.optional(),
    returnTime: z.union([timeStringSchema, z.literal("23:59")]).optional(),
    /**
     * REQ §13.110 (b): how each end was entered. `departTime`/`returnTime` stay the car's own
     * times (what the solver reads); with `departAnchor = "arrive"` the typed time is
     * `arriveByTime` and `departTime` is derived from it (arrive-by − outbound route minutes,
     * rounded down); with `returnAnchor = "leave"` the typed time is `leaveDestTime` and
     * `returnTime` is derived (+ return route minutes, rounded up). Only the sentence layout
     * writes them (`mapper.ts` sends the anchor keys only then).
     */
    departAnchor: timeAnchorSchema,
    arriveByTime: timeStringSchema.optional(),
    returnAnchor: timeAnchorSchema,
    leaveDestTime: timeStringSchema.optional(),
    /**
     * REQ §13.112 (c), weekly sentence layout: "יש לי חלון זמן?" — `window` replaces the two time chips with
     * "N hours between A and B". Only the fields of the active mode count; switching never clears the other mode's
     * values. `mapper.ts` stores a window as the earliest block + later-only slack + `duration_locked`.
     */
    timeMode: z.enum(["fixed", "window"]).optional(),
    windowHours: z.number().int().min(1).max(12).optional(),
    windowStart: timeStringSchema.optional(),
    windowEnd: timeStringSchema.optional(),
    /**
     * REQ §13.112 (a)/(b), weekly sentence layout only ("אם אין רכב…"): `none`/absent = no line, `alternative` = plan B
     * (a הקפצה to `altPlace` by `altArriveBy`, optionally picked up from there at `altPickupAt`), `manage` = "אסתדר".
     * Clock times on the main day; the fields of an inactive line are kept but not validated or sent (`planB.ts`).
     */
    fallback: requestFallbackSchema.optional(),
    altPlace: originValueSchema.optional(),
    altArriveBy: timeStringSchema.optional(),
    altPickup: z.boolean().optional(),
    altPickupAt: timeStringSchema.optional(),
    /** Pickup place other than the drop place; empty/absent = "משם" (from the drop place). */
    altPickupPlace: originValueSchema.optional(),
    /**
     * REQ §13.112 (e): the previous main trip + plan B while the request is the plan-B הקפצה (`planB.ts`
     * `snapshotMainTrip`) so switching back restores both. Form state only — never validated, never submitted.
     */
    mainTripBackup: z.custom<MainTripSnapshot>().optional(),
    /** Kept for old callers; overnight values are rejected. No UI toggle. */
    returnNextDay: z.boolean(),
    /**
     * REQ §88 (owner 2026-09-15): the member no longer chooses this — the solver/Sadran
     * decide relay vs. passenger per leg (`canDrive`), and `submit_request` defaults it
     * server-side. Kept optional here only so `mapEditRowToValues` can still read the
     * decided mode off an existing request row without widening `RequestFormValues`.
     */
    oneWayCarMode: z.enum(ONE_WAY_CAR_MODES).optional(),
    needsCarAtDestination: z.boolean(),
    adults: z.number().int().min(1).max(8),
    childSeats: z.number().int().min(0).max(8),
    boosters: z.number().int().min(0).max(8),
    /**
     * R9B1/R9M1: adults beyond the requester and the named people (companions, guests, adult
     * children) — "+ מבוגר/ת" without a name. Edit prefill derives it from the stored `adults`
     * (`seatCounts.ts` `extraAdultsFromStored`) so an edit never loses seats.
     */
    extraAdults: z.number().int().min(0).max(7),
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
    /** Sentence layout (R9U6): "רכב מסוים" was chosen — a car must follow (no preselection). */
    preferSpecificCar: z.boolean().optional(),
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

    // REQ §13.112 (c): in window mode the window's own fields replace the fixed times.
    const windowMode = windowModeActive(value);
    if (windowMode) {
      const problem = windowProblem(value);
      if (problem === "missing") {
        ctx.addIssue({ path: ["windowEnd"], code: z.ZodIssueCode.custom, message: he.requestSentence.window.required });
      } else if (problem === "tooShort") {
        ctx.addIssue({ path: ["windowEnd"], code: z.ZodIssueCode.custom, message: he.requestSentence.window.tooShort });
      }
    }

    if (!windowMode && needsDepart && !value.departTime) {
      ctx.addIssue({ path: ["departTime"], code: z.ZodIssueCode.custom, message: he.field.depart });
    }
    if (!windowMode && needsReturn && !value.returnTime) {
      ctx.addIssue({ path: ["returnTime"], code: z.ZodIssueCode.custom, message: he.field.return });
    }

    if (!windowMode && needsDepart && needsReturn && !isMultiDay && value.departTime && value.returnTime) {
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

    // R7B12 (REQ §13.109 e): the same place as origin and destination is a trip to nowhere.
    if (isSamePlace(value.origin, value.destination)) {
      ctx.addIssue({ path: ["destination"], code: z.ZodIssueCode.custom, message: he.request.originEqualsDestination });
    }

    // R3B21: a stop equal to the place the leg already ends/starts at is a no-op detour.
    const originPlace = value.origin;
    value.outStops.forEach((stop, index) => {
      if (isSamePlace(stop, originPlace)) {
        ctx.addIssue({ path: ["outStops", index], code: z.ZodIssueCode.custom, message: he.request.stopEqualsOrigin });
      }
    });
    value.returnStops.forEach((stop, index) => {
      if (isSamePlace(stop, value.destination)) {
        ctx.addIssue({ path: ["returnStops", index], code: z.ZodIssueCode.custom, message: he.request.stopEqualsDestination });
      }
    });

    // REQ §13.112 (a): an active plan B needs its place and times, the pickup after the arrival, and a drop place that is not the origin.
    if (planBActive(value)) {
      const messages = {
        placeRequired: he.planB.error.placeRequired,
        arriveRequired: he.planB.error.arriveRequired,
        pickupRequired: he.planB.error.pickupRequired,
        pickupBeforeArrive: he.planB.error.pickupBeforeArrive,
      };
      for (const { field, problem } of planBProblems(value)) {
        ctx.addIssue({ path: [field], code: z.ZodIssueCode.custom, message: messages[problem] });
      }
      if (hasAltPlace(value.altPlace) && value.altPlace && isSamePlace(value.altPlace, value.origin)) {
        ctx.addIssue({ path: ["altPlace"], code: z.ZodIssueCode.custom, message: he.planB.error.sameAsOrigin });
      }
      if (value.altPickup && hasAltPlace(value.altPickupPlace) && value.altPickupPlace && isSamePlace(value.altPickupPlace, value.origin)) {
        ctx.addIssue({ path: ["altPickupPlace"], code: z.ZodIssueCode.custom, message: he.planB.error.pickupSameAsOrigin });
      }
    }

    if (value.preferSpecificCar && !value.preferredCarId) {
      ctx.addIssue({ path: ["preferredCarId"], code: z.ZodIssueCode.custom, message: he.requestSentence.carRequired });
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

export const REQUEST_FORM_DEFAULTS: Omit<RequestFormValues, "departmentId" | "weekStart" | "day" | "dayIndex" | "rideTypeId" | "destination" | "origin"> = {
  preferredCarId: "",
  tripShape: "round_trip",
  tripType: "round_trip",
  dropOffPickup: false,
  departTime: "08:00",
  returnTime: "12:00",
  departAnchor: "leave",
  arriveByTime: undefined,
  returnAnchor: "arrive",
  leaveDestTime: undefined,
  returnNextDay: false,
  oneWayCarMode: undefined,
  needsCarAtDestination: true,
  adults: 1,
  childSeats: 0,
  boosters: 0,
  extraAdults: 0,
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
  outStops: [],
  returnStops: [],
};

/**
 * `v_request_template_suggestions` row (DATA_MODEL.md §3.6, `supabase/migrations/
 * 20260910092000_request_templates_as_suggestions.sql`), validated at the `requests/api.ts`
 * boundary before it reaches the UI. `depart_at`/`return_at` already fall on the suggestion's
 * `week_start` (computed in SQL from `depart_dow`/`depart_time` etc.), so the prefill mapper
 * (`../templatePrefill.ts`) can read them exactly like `RequestEditRow`'s own instants.
 */
/**
 * One `v_request_template_suggestions.stops`/`v_my_requests.stops`/`v_board_rides.served[].stops`
 * element (REQ §13.93 "Multi-stop rides", ORIGINS_PLAN §6.1) — `eta` is always null on a
 * template suggestion (no committed request to compute a real one against).
 */
export const requestStopRowSchema = z.object({
  leg: z.enum(["out", "return"]),
  position: z.number(),
  place_id: z.string().nullable(),
  place_text: z.string().nullable(),
  name: z.string(),
  eta: z.string().nullable(),
  /** REQ §13.97 — absent on older rows = active. */
  active: z.boolean().default(true),
});

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
  /** REQ §13.93 (ORIGINS_PLAN step O2): `origin_id`/`origin_text`/`trip_type`, copied by `save_request_template`. */
  origin_id: z.string().nullable(),
  origin_text: z.string().nullable(),
  origin_name: z.string().nullable(),
  trip_type: tripTypeSchema,
  depart_dow: z.number().nullable(),
  depart_time: z.string().nullable(),
  return_dow: z.number().nullable(),
  return_time: z.string().nullable(),
  depart_at: z.string().nullable(),
  return_at: z.string().nullable(),
  one_way_car_mode: z.enum(ONE_WAY_CAR_MODES).nullable(),
  /** REQ §13.110 (b): how each end was entered; absent on pre-anchor rows. */
  depart_anchor: timeAnchorSchema.nullish(),
  arrive_by: z.string().nullish(),
  return_anchor: timeAnchorSchema.nullish(),
  leave_dest_at: z.string().nullish(),
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
  /** REQ §13.112 (c); absent on rows from before the column. */
  duration_locked: z.boolean().nullish(),
  preferred_car_id: z.string().nullable(),
  ride_description: z.string().nullable(),
  guest_passenger_names: z.array(z.string()),
  notes: z.string().nullable(),
  /** REQ §13.93 "Multi-stop rides": `request_templates.stops`, prefill only. */
  stops: z.array(requestStopRowSchema),
});

export type TemplateSuggestionRow = z.infer<typeof templateSuggestionRowSchema>;

/**
 * `joinable_rides_for_request(request_id)` row (REQ §13.83, `supabase/migrations/
 * 20260914130000_join_radius_and_joinable_rides.sql`, extended with `driver_phone` by
 * `20260914160000_joinable_rides_driver_phone.sql`), validated at the `requests/api.ts`
 * boundary — the generated return type does not mark the left-joined driver columns
 * nullable, but a still-unclaimed chauffeur ride has no driver row at all.
 */
export const joinableRideRowSchema = z.object({
  ride_id: z.string(),
  starts_at: z.string(),
  ends_at: z.string(),
  car_name: z.string(),
  car_type: carTypeSchema,
  destination_name: z.string(),
  driver_name: z.string(),
  distance_km: z.number(),
  free_seats: z.number(),
  /** `profiles.phone`, null when the driver has none or the ride has no driver yet. */
  driver_phone: z.string().nullable(),
});

export type JoinableRideRowRaw = z.infer<typeof joinableRideRowSchema>;
