import { addDays, format, parseISO } from "date-fns";
import { fromZonedTime } from "date-fns-tz";

import { TZ } from "@/lib/time";

import type { SubmitRequestPayload } from "./api";
import type { RequestFormValues } from "./schema";

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
    one_way_car_mode: !isRoundTrip ? values.oneWayCarMode : undefined,
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
  };
}
