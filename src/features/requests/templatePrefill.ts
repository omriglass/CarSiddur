import { datesOfWeek } from "@/components/DateField";
import { dateKey, formatTime } from "@/lib/time";

import { intervalToFlexValue, type FlexValue } from "./mapper";
import { REQUEST_FORM_DEFAULTS, type RequestFormValues } from "./schema";

import type { TemplateSuggestion } from "./api";

function dayFromInstant(instant: string): string {
  return dateKey(instant);
}
function timeFromInstant(instant: string): string {
  return formatTime(new Date(instant));
}

/**
 * Pure mapper: a `v_request_template_suggestions` row (already anchored to `weekStart` — its
 * `departAt`/`returnAt` are computed in SQL from `departDow`/`departTime` etc., DATA_MODEL
 * §3.6) into `RequestForm`'s default values, exactly like `mapEditRowToValues` does for an
 * existing request. Always turns `repeatWeekly` on: submitting a prefilled suggestion keeps
 * the request repeating unless the member turns the switch off (REQ §76).
 */
export function suggestionToFormValues(row: TemplateSuggestion, weekStart: string): RequestFormValues {
  const day = row.departAt ? dayFromInstant(row.departAt) : row.returnAt ? dayFromInstant(row.returnAt) : weekStart;
  const dates = datesOfWeek(weekStart);
  const departTime = row.departAt ? timeFromInstant(row.departAt) : undefined;
  const returnTime = row.returnAt ? timeFromInstant(row.returnAt) : undefined;

  return {
    ...REQUEST_FORM_DEFAULTS,
    departmentId: row.departmentId,
    weekStart,
    day,
    dayIndex: Math.max(dates.indexOf(day), 0),
    destination: row.destinationId
      ? { presetId: row.destinationId, name: row.destinationName ?? "" }
      : { freeText: row.destinationText ?? "" },
    rideTypeId: row.rideTypeId,
    preferredCarId: row.preferredCarId ?? "",
    tripShape: row.tripShape,
    departTime,
    returnTime,
    returnNextDay: false,
    oneWayCarMode: (row.oneWayCarMode ?? undefined) as "relay" | "passenger" | undefined,
    needsCarAtDestination: row.needsCarAtDestination,
    adults: row.adults,
    childSeats: row.childIds.length,
    legacyChildSeats: row.childIds.length ? 0 : row.childSeats,
    boosters: row.boosters,
    companions: row.companionIds,
    children: row.childIds,
    luggage: row.hasLuggage,
    flexDepartEarly: intervalToFlexValue(row.flexDepartEarly) as FlexValue,
    flexDepartLate: intervalToFlexValue(row.flexDepartLate) as FlexValue,
    flexReturnEarly: intervalToFlexValue(row.flexReturnEarly) as FlexValue,
    flexReturnLate: intervalToFlexValue(row.flexReturnLate) as FlexValue,
    notes: row.notes ?? "",
    rideDescription: row.rideDescription ?? "",
    guestNames: row.guestPassengerNames.join("\n"),
    repeatWeekly: true,
  };
}
