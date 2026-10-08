import { addDays, format, parseISO } from "date-fns";
import { fromZonedTime } from "date-fns-tz";

import { TZ } from "@/lib/time";

import { hasAltPlace, planBActive, planBOffered } from "./planB";
import { isSamePlace, type RequestFormValues } from "./schema";
import { destinationValuesToStopPayload } from "./stops";
import { slackInterval, windowCarTimes, windowModeActive } from "./timeWindow";

import type { SubmitRequestPayload } from "./api";
import type { DestinationValue } from "@/components/DestinationCombobox";

/** = `FlexibilitySegmented`'s `FlexValue` (`0|15|30|60|120|'any'`); `interval` column, DATA_MODEL §5.1. */
export type FlexValue = 0 | 15 | 30 | 60 | 120 | "any";

const FLEX_TO_INTERVAL: Record<FlexValue, string> = {
  0: "0",
  15: "15 min",
  30: "30 min",
  60: "1 hour",
  120: "2 hours",
  any: "1 day",
};

/** `submit_request` payload flex fields are interval literals (DATA_MODEL §3.6/5.1: `'1 day'` = "any time that day"). */
export function flexValueToInterval(value: FlexValue): string {
  return FLEX_TO_INTERVAL[value];
}

/** Inverse of `flexValueToInterval`, for prefilling the edit form from a stored `interval` (returned as text by postgres). */
export function intervalToFlexValue(interval: string): FlexValue {
  const trimmed = interval.trim().toLowerCase();
  if (trimmed.includes("day")) return "any";
  const match = /^(\d+):(\d{2}):\d{2}$/.exec(trimmed);
  if (!match) return 0;
  const totalMinutes = Number(match[1]) * 60 + Number(match[2]);
  if (totalMinutes >= 120) return 120;
  if (totalMinutes >= 60) return 60;
  if (totalMinutes >= 30) return 30;
  if (totalMinutes >= 15) return 15;
  return 0;
}

/** Combines a `yyyy-MM-dd` day with an `HH:MM` time into an Asia/Jerusalem instant (ISO string, UTC). */
export function toInstant(day: string, time: string, nextDay: boolean): string {
  const base = nextDay ? format(addDays(parseISO(day), 1), "yyyy-MM-dd") : day;
  return fromZonedTime(`${base}T${time}:00`, TZ).toISOString();
}

export interface SubmitPayloadOptions {
  requestId?: string;
  expectedVersion?: number;
  joinRideId?: string;
  /** Parsed non-member passengers (`guestPassengerNames()`, `../quickRequest.ts`). */
  guestPassengerNames?: string[];
  /** Live one-way quick request: reserve a vehicle while awaiting a driver (quick variant only). */
  reserveMissingDriver?: boolean;
  /**
   * REQ §13.110 (b): `sentence` also sends the four anchor keys (the classic layout must not —
   * the server keeps and shifts the stored anchors). Omitted for a multi-day series: its legs
   * share one payload, so a single `arrive_by` cannot fit every leg's day.
   */
  layout?: "sentence" | "classic";
  isSeries?: boolean;
  /** REQ §13.112 (a)/(b): the weekly form (either layout) also sends its plan-B / "אסתדר" line (never quick / car-now). */
  planB?: boolean;
}

/**
 * The anchor keys of a sentence-layout submit. `arrive_by`/`leave_dest_at` are instants on the
 * request's own day(s), exactly like `depart_at`/`return_at`; the unused one is an explicit
 * `null` so a request edited from "arrive by" back to "leave at" clears the stored value.
 */
export function anchorPayload(values: RequestFormValues): Pick<SubmitRequestPayload, "depart_anchor" | "arrive_by" | "return_anchor" | "leave_dest_at"> {
  const needsDepart = values.tripShape !== "one_way_from";
  const needsReturn = values.tripShape !== "one_way_to";
  const arriveBy = needsDepart && values.departAnchor === "arrive" && values.arriveByTime ? values.arriveByTime : null;
  const leaveDest = needsReturn && values.returnAnchor === "leave" && values.leaveDestTime ? values.leaveDestTime : null;
  return {
    depart_anchor: arriveBy ? "arrive" : "leave",
    arrive_by: arriveBy ? toInstant(values.day, arriveBy, false) : null,
    return_anchor: needsReturn ? (leaveDest ? "leave" : "arrive") : values.returnAnchor,
    leave_dest_at: leaveDest ? toInstant(values.returnDay || values.day, leaveDest, false) : null,
  };
}

/**
 * REQ §13.112 (c), sentence layout only: the window mode stores the earliest block (`depart_at` = A,
 * `return_at` = A + N), later-only slack (B − (A + N)) on both ends, default anchors and `duration_locked: true`;
 * the fixed mode always says `duration_locked: false`, so an edit that goes back to fixed hours clears the lock.
 * The classic layout sends no `duration_locked` key — the server keeps the stored lock while the length is unchanged.
 */
export function windowPayload(values: RequestFormValues): Pick<SubmitRequestPayload, "duration_locked" | "depart_at" | "return_at" | "flex_depart_early" | "flex_depart_late" | "flex_return_early" | "flex_return_late" | "depart_anchor" | "arrive_by" | "return_anchor" | "leave_dest_at"> | { duration_locked: false } {
  const times = windowModeActive(values) ? windowCarTimes(values) : null;
  if (!times) return { duration_locked: false };
  const slack = slackInterval(times.slackMinutes);
  return {
    duration_locked: true,
    depart_at: toInstant(values.day, times.departTime, false),
    return_at: toInstant(values.day, times.returnTime, false),
    flex_depart_early: flexValueToInterval(0),
    flex_depart_late: slack,
    flex_return_early: flexValueToInterval(0),
    flex_return_late: slack,
    depart_anchor: "leave",
    arrive_by: null,
    return_anchor: "arrive",
    leave_dest_at: null,
  };
}

/**
 * REQ §13.112 (a)/(b), weekly form (sentence and classic layouts, since 2026-10-08). A הלוך-חזור / הלוך בלבד on one day always sends its state
 * (`none` + `alternative: null` when the line was removed, so an edit clears a stored plan B); a הקפצה sends nothing —
 * the server keeps a stored plan B inactive. Plan B times are clock times on the request's own day (`values.day`),
 * so changing the main day moves plan B with it.
 */
/** A pickup place other than the drop place (an equal one is the same as none); empty = from the drop place. */
function pickupPlacePayload(pickupPlace: DestinationValue | undefined, dropPlace: DestinationValue): { pickup_place_id?: string; pickup_place_text?: string } {
  if (!hasAltPlace(pickupPlace) || !pickupPlace || isSamePlace(pickupPlace, dropPlace)) return {};
  return "presetId" in pickupPlace ? { pickup_place_id: pickupPlace.presetId } : { pickup_place_text: pickupPlace.freeText.trim() };
}

export function fallbackPayload(values: RequestFormValues): Pick<SubmitRequestPayload, "fallback" | "alternative"> {
  if (!planBOffered(values)) return {};
  if (planBActive(values) && values.altPlace && values.altArriveBy) {
    const place = values.altPlace;
    const pickup = !!values.altPickup && !!values.altPickupAt;
    return {
      fallback: "alternative",
      alternative: {
        ...("presetId" in place ? { drop_place_id: place.presetId } : { drop_place_text: place.freeText.trim() }),
        arrive_by: toInstant(values.day, values.altArriveBy, false),
        pickup,
        pickup_at: pickup && values.altPickupAt ? toInstant(values.day, values.altPickupAt, false) : null,
        ...(pickup ? pickupPlacePayload(values.altPickupPlace, place) : {}),
      },
    };
  }
  return { fallback: values.fallback === "manage" ? "manage" : "none", alternative: null };
}

/** Builds the `submit_request` RPC payload from validated form values (schema.ts). */
export function toSubmitRequestPayload(
  values: RequestFormValues,
  options: SubmitPayloadOptions = {},
): SubmitRequestPayload {
  const needsDepart = values.tripShape !== "one_way_from";
  const needsReturn = values.tripShape !== "one_way_to";
  const isRoundTrip = values.tripShape === "round_trip";

  return {
    department_id: values.departmentId,
    week_start: values.weekStart,
    destination_id: "presetId" in values.destination ? values.destination.presetId : undefined,
    destination_text: "freeText" in values.destination ? values.destination.freeText : undefined,
    // REQ §13.93: an empty origin (the placeholder `emptyValues()` default, before `RequestForm`
    // resolves the member's real default) sends neither field, which is exactly what tells
    // `submit_request` to resolve its own default — never an empty string origin_text.
    origin_id: values.origin && "presetId" in values.origin ? values.origin.presetId : undefined,
    origin_text: values.origin && "freeText" in values.origin && values.origin.freeText.trim() ? values.origin.freeText.trim() : undefined,
    trip_type: values.tripType,
    ride_type_id: values.rideTypeId,
    preferred_car_id: values.preferredCarId || null,
    trip_shape: values.tripShape,
    depart_at: needsDepart && values.departTime ? toInstant(values.day, values.departTime, false) : undefined,
    // Multi-day request (REQ §13.77): `returnDay` (when set and later than `day`) puts the
    // return instant on that later calendar day instead — the same shape `submit_series_request`
    // expects for its own `depart_at`/`return_at` span (`RequestForm.tsx` picks the RPC).
    return_at:
      needsReturn && values.returnTime
        ? toInstant(values.returnDay || values.day, values.returnTime, false)
        : undefined,
    adults: values.adults,
    child_seats: values.childSeats,
    boosters: values.boosters,
    has_luggage: values.luggage,
    needs_car_at_destination: isRoundTrip ? values.needsCarAtDestination : undefined,
    // REQ §88: the member no longer chooses a one-way car mode — `submit_request`
    // defaults it server-side from the requester's `does_not_drive` flag. The one
    // exception is the live-week quick one-way reservation (UX_FLOWS §18): it books a
    // missing-driver ride for the member, so it is a `passenger` leg by definition and
    // `submit_request` refuses `reserve_missing_driver` with any other mode.
    one_way_car_mode: options.reserveMissingDriver && !isRoundTrip ? "passenger" : undefined,
    flex_depart_early: flexValueToInterval(values.flexDepartEarly as FlexValue),
    flex_depart_late: flexValueToInterval(values.flexDepartLate as FlexValue),
    flex_return_early: flexValueToInterval(values.flexReturnEarly as FlexValue),
    flex_return_late: flexValueToInterval(values.flexReturnLate as FlexValue),
    notes: values.notes.trim() || undefined,
    ride_description: values.rideDescription.trim() || null,
    guest_passenger_names: options.guestPassengerNames?.length ? options.guestPassengerNames : undefined,
    reserve_missing_driver: options.reserveMissingDriver || undefined,
    request_id: options.requestId,
    expected_version: options.expectedVersion,
    join_ride_id: options.joinRideId,
    // REQ §13.93 "Multi-stop rides": always sent (even `[]`) so an edit can clear a
    // previously-added stop — `submit_request` only leaves existing stops untouched when the
    // key is entirely absent from the payload. REQ §13.97: the complete list for both legs — a
    // one-way request still sends its (inactive) return stops so the server keeps them.
    stops: [
      ...destinationValuesToStopPayload(values.outStops, "out"),
      ...destinationValuesToStopPayload(values.returnStops, "return"),
    ],
    ...(options.layout === "sentence" && !options.isSeries ? anchorPayload(values) : {}),
    ...(options.layout === "sentence" && !options.isSeries ? windowPayload(values) : {}),
    // Both layouts show plan B (REQ §13.112 e), so both send it; quick / car-now never do.
    ...(options.planB && !options.isSeries ? fallbackPayload(values) : {}),
  };
}

/**
 * The edit form's return time (UX_FLOWS §3.4): the request's own `return_at`, else - for a
 * one-way request - the return time it kept (`kept_return_at`), so switching back to a round
 * trip restores it instead of asking again. Pass `timeOf` (instant -> "HH:mm").
 */
export function editReturnInstant(row: { returnAt: string | null; keptReturnAt?: string | null }): string | null {
  return row.returnAt ?? row.keptReturnAt ?? null;
}
