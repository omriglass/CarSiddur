// REQ §13.112 (a)/(b), sentence layout only: the "אם אין רכב…" line of a הלוך-חזור / הלוך בלבד request —
// plan B ("הקפצה to a drop point by a time, optionally picked up from the same place") or "אסתדר".
// Pure helpers (no React, no Hebrew): offered / active gates, defaults, validation, edit prefill.
//
// Repeat-weekly templates deliberately do NOT carry a fallback (owner decision 2026-10-08): a plan B is a
// per-trip decision with absolute clock times, so `templatePrefill.ts` never fills these fields.
import type { DestinationValue } from "@/components/DestinationCombobox";
import type { RequestFallbackValue } from "@/lib/enums";

import type { RequestFormValues } from "./schema";
import { departFromArriveBy, returnFromLeaveThere } from "./timeAnchors";
import { tripTypeToLegacyFields } from "./tripType";

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

/**
 * Plan B's drop time moved: when it reaches or passes the pickup, the pickup moves by the same amount
 * (like `shiftReturnByDepartureDelta` for the main return) so the member never meets a "pickup before arrival"
 * error under an open picker. Returns the (possibly unchanged) pickup time; `moved` says whether it changed.
 */
export function pickupAfterArrivalMoved(previousArrive: string, nextArrive: string, pickupAt: string | undefined): { pickupAt: string | undefined; moved: boolean } {
  if (!pickupAt) return { pickupAt, moved: false };
  if (toMinutes(nextArrive) < toMinutes(pickupAt)) return { pickupAt, moved: false };
  const shifted = shiftTime(pickupAt, toMinutes(nextArrive) - toMinutes(previousArrive));
  return { pickupAt: shifted, moved: shifted !== pickupAt };
}

/** The earliest pickup time a plan B with this arrival may have (one grid step after it). */
export function earliestPickup(arriveBy: string): string {
  return shiftTime(arriveBy, 15);
}

// ---- Switching the main trip to a הקפצה (REQ §13.112 e) -------------------------------------------------

/** A complete plan B as the form holds it. */
export interface PlanBDetails {
  place: DestinationValue;
  arriveBy: string;
  pickup: boolean;
  pickupAt?: string;
  /** Pickup place other than `place`; absent = from the drop place. */
  pickupPlace?: DestinationValue;
}

/** The active, complete plan B of the form values (`null` when there is none or it is unfinished). */
export function planBDetails(values: OfferScope & Pick<RequestFormValues, "fallback" | "altPlace" | "altArriveBy" | "altPickup" | "altPickupAt" | "altPickupPlace">): PlanBDetails | null {
  if (!planBActive(values) || !values.altPlace || !hasAltPlace(values.altPlace) || !values.altArriveBy) return null;
  const pickup = !!values.altPickup && !!values.altPickupAt;
  return {
    place: values.altPlace,
    arriveBy: values.altArriveBy,
    pickup,
    pickupAt: pickup ? values.altPickupAt : undefined,
    pickupPlace: pickup && hasAltPlace(values.altPickupPlace) ? values.altPickupPlace : undefined,
  };
}

/** The form fields that make up "the main trip" and are kept while the request is a plan-B הקפצה. */
const SNAPSHOT_KEYS = [
  "tripType", "dropOffPickup", "tripShape", "needsCarAtDestination", "oneWayCarMode", "destination", "outStops", "returnStops",
  "departTime", "returnTime", "departAnchor", "arriveByTime", "returnAnchor", "leaveDestTime",
  "fallback", "altPlace", "altArriveBy", "altPickup", "altPickupAt", "altPickupPlace",
] as const;

/** The previous main trip + its plan B, kept in form state (never submitted) so switching back restores both exactly. */
// A plain record on purpose: typing it from `RequestFormValues` would make that type depend on itself (the schema holds it).
export type MainTripSnapshot = Record<string, unknown>;

export function snapshotMainTrip(values: RequestFormValues): MainTripSnapshot {
  const snapshot: Record<string, unknown> = {};
  for (const key of SNAPSHOT_KEYS) snapshot[key] = structuredClone(values[key]);
  return snapshot;
}

/** The form patch that restores a snapshot. */
export function restoreMainTripPatch(snapshot: MainTripSnapshot): Partial<RequestFormValues> {
  return structuredClone(snapshot) as Partial<RequestFormValues>;
}

/**
 * The form patch that makes plan B the main request: a הקפצה to the drop place, the outbound entered as
 * "להגיע עד" plan B's arrive-by, the pickup (when there is one) entered as "איסוף משם ב־" its time; stops
 * belong to the old route and are cleared (the snapshot keeps them); plan B itself is cleared (REQ §13.97: the
 * snapshot keeps it too). The car times (`departTime`/`returnTime`) are derived by the caller from route minutes.
 */
export function dropOffFromPlanBPatch(plan: PlanBDetails, anchored: boolean): Partial<RequestFormValues> {
  const legacy = tripTypeToLegacyFields("drop_off", plan.pickup);
  return {
    tripType: "drop_off",
    dropOffPickup: plan.pickup,
    ...legacy,
    destination: plan.place,
    outStops: [],
    returnStops: [],
    // The classic form has no anchors: its car times are set directly (`dropOffCarTimes`).
    departAnchor: anchored ? "arrive" : "leave",
    arriveByTime: anchored ? plan.arriveBy : undefined,
    returnAnchor: anchored && plan.pickup ? "leave" : "arrive",
    leaveDestTime: anchored && plan.pickup ? plan.pickupAt : undefined,
    fallback: "none",
  };
}

/** The car times of the plan-B הקפצה: leave early enough to arrive by plan B's time, back home after the pickup + drive. */
export function dropOffCarTimes(plan: PlanBDetails, routes: { outMinutes: number; returnMinutes: number }): { departTime: string; returnTime?: string } {
  return {
    departTime: departFromArriveBy(plan.arriveBy, routes.outMinutes),
    returnTime: plan.pickup && plan.pickupAt ? returnFromLeaveThere(plan.pickupAt, routes.returnMinutes) : undefined,
  };
}

/** The pickup place the main הקפצה cannot model (it always picks up from its own destination); `null` when none. */
export function droppedPickupPlace(plan: PlanBDetails): DestinationValue | null {
  return plan.pickup && plan.pickupPlace ? plan.pickupPlace : null;
}

/** The department's places with the drop points (`is_drop_point`) first, each group in its own order (the plan-B place lists). */
export function dropPointsFirst<T extends { is_drop_point?: boolean }>(places: readonly T[]): T[] {
  return [...places.filter((place) => place.is_drop_point), ...places.filter((place) => !place.is_drop_point)];
}
