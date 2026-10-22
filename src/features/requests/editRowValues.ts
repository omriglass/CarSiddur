// The edit form's starting values for a stored request (UX_FLOWS §3.4) — shared by `RequestForm` (edit mode) and the
// "my rides" week view, which moves a request by dragging it (owner 2026-10-12): that sends exactly what opening the
// edit form, changing the times and saving would send. Pure.
import { datesOfWeek } from "@/components/dateFieldDates";
import { dateKey, formatTime } from "@/lib/time";

import type { RequestEditRow } from "./api";
import { isKeepCarRow } from "./keepCar";
import { editReturnInstant, intervalToFlexValue } from "./mapper";
import { planBFormFields } from "./planB";
import type { RequestFormValues } from "./schema";
import { anchorFormFields } from "./timeAnchors";
import { windowFormFields } from "./timeWindow";
import { initialTripType } from "./tripType";

function dayFromInstant(instant: string): string {
  return dateKey(instant);
}
function timeFromInstant(instant: string): string {
  return formatTime(new Date(instant));
}

export function editRowToFormValues(row: RequestEditRow, weekStart: string, companions: string[], children: string[], extraAdults: number, unnamedChildSeats: number): RequestFormValues {
  const day = row.departAt ? dayFromInstant(row.departAt) : row.returnAt ? dayFromInstant(row.returnAt) : weekStart;
  const dates = datesOfWeek(weekStart);
  const departTime = row.departAt ? timeFromInstant(row.departAt) : undefined;
  const returnInstant = editReturnInstant(row);
  const returnTime = returnInstant ? timeFromInstant(returnInstant) : undefined;
  const returnNextDay = !!(
    row.departAt &&
    row.returnAt &&
    dayFromInstant(row.returnAt) !== dayFromInstant(row.departAt)
  );

  return {
    departmentId: row.departmentId,
    weekStart,
    day,
    dayIndex: Math.max(dates.indexOf(day), 0),
    // A multi-day request reopens over its whole span (owner 2026-10-22): the last day; else equal to `day`.
    returnDay: row.seriesId && row.seriesReturnAt ? dayFromInstant(row.seriesReturnAt) : day,
    destination: row.destinationId
      ? { presetId: row.destinationId, name: row.destinationName ?? "" }
      : { freeText: row.destinationText ?? "" },
    origin: row.originId
      ? { presetId: row.originId, name: row.originName ?? "" }
      : { freeText: row.originText ?? "" },
    outStops: row.outStops ?? [],
    returnStops: row.returnStops ?? [],
    rideTypeId: row.rideTypeId,
    preferredCarId: row.preferredCarId ?? "",
    // A kept-car request reopens as a round trip, so its legacy fields are the round trip's.
    tripShape: isKeepCarRow(row) ? "round_trip" : row.tripShape,
    ...initialTripType(row),
    keepCarAtDestination: isKeepCarRow(row),
    departTime,
    returnTime: row.seriesId && row.seriesReturnAt ? timeFromInstant(row.seriesReturnAt) : returnNextDay ? "23:59" : returnTime,
    ...anchorFormFields(row, timeFromInstant),
    // REQ §13.112 (a)/(b): the stored "אם אין רכב" line reopens as it was saved.
    ...planBFormFields(row, timeFromInstant),
    // REQ §13.112 (c): a window request reopens in window mode (the fixed fields keep the nominal block).
    ...windowFormFields({ durationLocked: row.durationLocked, departAt: row.departAt, returnAt: row.returnAt, flexReturnLate: row.flexReturnLate }),
    returnNextDay: false,
    oneWayCarMode: (row.oneWayCarMode ?? undefined) as "relay" | "passenger" | undefined,
    needsCarAtDestination: isKeepCarRow(row) ? true : row.needsCarAtDestination,
    adults: row.adults,
    extraAdults,
    preferSpecificCar: !!row.preferredCarId,
    childSeats: children.length,
    // REQ §13.112 (d): the stored child seats minus the seat-using named children are the unnamed ones.
    legacyChildSeats: unnamedChildSeats,
    boosters: row.boosters,
    companions,
    children,
    luggage: row.hasLuggage,
    flexDepartEarly: intervalToFlexValue(row.flexDepartEarly),
    flexDepartLate: intervalToFlexValue(row.flexDepartLate),
    flexReturnEarly: intervalToFlexValue(row.flexReturnEarly),
    flexReturnLate: intervalToFlexValue(row.flexReturnLate),
    notes: row.notes ?? "",
    rideDescription: row.rideDescription ?? "",
    guestNames: (row.guestPassengerNames ?? []).join("\n"),
    repeatWeekly: !!row.templateId,
  };
}
