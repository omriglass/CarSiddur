// REQ §13.112 (a)/(b), sentence layout only: the "אם אין רכב…" line of a הלוך-חזור / הלוך בלבד request —
// plan B ("הקפצה to a drop point by a time, optionally picked up from the same place") or "אסתדר".
// Pure helpers (no React, no Hebrew): offered / active gates, defaults, validation, edit prefill.
//
// Repeat-weekly templates deliberately do NOT carry a fallback (owner decision 2026-10-08): a plan B is a
// per-trip decision with absolute clock times, so `templatePrefill.ts` never fills these fields.
import type { DestinationValue } from "@/components/DestinationCombobox";
import type { RequestFallbackValue } from "@/lib/enums";

import type { RequestFormValues } from "./schema";

/** The default "be there by" is the main departure plus this much (the member leaves home later than a car ride would). */
export const PLAN_B_ARRIVE_OFFSET_MINUTES = 60;
/** The default pickup is the main return time; when that is not after the arrival, this long after it. */
export const PLAN_B_PICKUP_AFTER_MINUTES = 240;

const DAY_END_MINUTES = 23 * 60 + 45;

type OfferScope = Pick<RequestFormValues, "tripType" | "day"> & { returnDay?: string };

/** The line exists only for a הלוך-חזור / הלוך בלבד on a single day (not a multi-day series, not a הקפצה). */
export function planBOffered(values: OfferScope): boolean {
  if (values.tripType !== "round_trip" && values.tripType !== "one_way") return false;
  return !values.returnDay || values.returnDay === values.day;
}

export function planBActive(values: OfferScope & { fallback?: RequestFallbackValue }): boolean {
  return planBOffered(values) && values.fallback === "alternative";
}

function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function fromMinutes(total: number): string {
  const clamped = Math.min(Math.max(total, 0), DAY_END_MINUTES);
  const rounded = Math.round(clamped / 15) * 15;
  const capped = Math.min(rounded, DAY_END_MINUTES);
  return `${String(Math.floor(capped / 60)).padStart(2, "0")}:${String(capped % 60).padStart(2, "0")}`;
}

/** `time` + `delta` minutes on the 15-minute grid, kept inside the day (00:00–23:45). */
export function shiftTime(time: string, delta: number): string {
  return fromMinutes(toMinutes(time) + delta);
}

/**
 * What the form fills in when the member adds plan B: the place stays empty (they must pick it); "be there by" is
 * the main departure + 1 h; a round trip asks for a pickup at the main return time (when that is after the arrival,
 * else 4 h after it), a one-way has no pickup until asked for.
 */
export function defaultPlanB(values: Pick<RequestFormValues, "tripType" | "departTime" | "returnTime" | "arriveByTime" | "departAnchor">): Pick<RequestFormValues, "altPlace" | "altArriveBy" | "altPickup" | "altPickupAt"> {
  const out = values.departAnchor === "arrive" && values.arriveByTime ? values.arriveByTime : (values.departTime ?? "08:00");
  const arriveBy = shiftTime(out, PLAN_B_ARRIVE_OFFSET_MINUTES);
  const pickup = values.tripType === "round_trip";
  const mainReturn = values.returnTime && values.returnTime !== "23:59" ? values.returnTime : undefined;
  const pickupAt = mainReturn && toMinutes(mainReturn) > toMinutes(arriveBy) ? mainReturn : shiftTime(arriveBy, PLAN_B_PICKUP_AFTER_MINUTES);
  return { altPlace: { freeText: "" }, altArriveBy: arriveBy, altPickup: pickup, altPickupAt: pickup ? pickupAt : undefined };
}

export function hasAltPlace(place: DestinationValue | undefined): boolean {
  if (!place) return false;
  return "presetId" in place ? !!place.presetId : place.freeText.trim() !== "";
}

export type PlanBProblem = "placeRequired" | "arriveRequired" | "pickupRequired" | "pickupBeforeArrive";

/** The first thing wrong with an active plan B (the same-as-origin check lives in the schema, which owns `isSamePlace`). */
export function planBProblems(values: Pick<RequestFormValues, "altPlace" | "altArriveBy" | "altPickup" | "altPickupAt">): { field: "altPlace" | "altArriveBy" | "altPickupAt"; problem: PlanBProblem }[] {
  const problems: { field: "altPlace" | "altArriveBy" | "altPickupAt"; problem: PlanBProblem }[] = [];
  if (!hasAltPlace(values.altPlace)) problems.push({ field: "altPlace", problem: "placeRequired" });
  if (!values.altArriveBy) problems.push({ field: "altArriveBy", problem: "arriveRequired" });
  if (values.altPickup) {
    if (!values.altPickupAt) problems.push({ field: "altPickupAt", problem: "pickupRequired" });
    else if (values.altArriveBy && toMinutes(values.altPickupAt) <= toMinutes(values.altArriveBy)) problems.push({ field: "altPickupAt", problem: "pickupBeforeArrive" });
  }
  return problems;
}

/** The stored plan B of a request row (`request_alternatives`), instants as ISO strings. */
export interface StoredAlternative {
  dropPlaceId: string | null;
  dropPlaceText: string | null;
  dropPlaceName: string | null;
  arriveBy: string;
  pickup: boolean;
  pickupAt: string | null;
  /** Pickup place when it is not the drop place (all null = from the drop place). */
  pickupPlaceId: string | null;
  pickupPlaceText: string | null;
  pickupPlaceName: string | null;
}

/**
 * Edit prefill: the stored fallback/plan B as form values (clock times of the stored instants; the form's
 * `day` decides the day when it is submitted again, so changing the main day moves plan B with it).
 */
export function planBFormFields(
  row: { fallback?: RequestFallbackValue | null; alternative?: StoredAlternative | null },
  timeOf: (instant: string) => string,
): Pick<RequestFormValues, "fallback" | "altPlace" | "altArriveBy" | "altPickup" | "altPickupAt" | "altPickupPlace"> {
  const fallback = row.fallback ?? "none";
  const alt = row.alternative;
  if (!alt) return { fallback, altPlace: undefined, altArriveBy: undefined, altPickup: undefined, altPickupAt: undefined, altPickupPlace: undefined };
  return {
    fallback,
    altPlace: alt.dropPlaceId ? { presetId: alt.dropPlaceId, name: alt.dropPlaceName ?? "" } : { freeText: alt.dropPlaceText ?? "" },
    altArriveBy: timeOf(alt.arriveBy),
    altPickup: alt.pickup,
    altPickupAt: alt.pickupAt ? timeOf(alt.pickupAt) : undefined,
    altPickupPlace: alt.pickupPlaceId
      ? { presetId: alt.pickupPlaceId, name: alt.pickupPlaceName ?? "" }
      : alt.pickupPlaceText ? { freeText: alt.pickupPlaceText } : undefined,
  };
}
