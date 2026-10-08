// Pure helpers behind the sentence layout (UX_FLOWS §3.4a): flexibility chips, the one-line
// car choice, the "who" summary. No React, no Hebrew.
import type { FlexValue } from "@/components/flexibilityValues";

import type { RequestFormValues } from "../../../schema";

/** The single value both sides share, or `null` when earlier and later differ (split mode). */
export function sharedFlexValue(early: FlexValue, late: FlexValue): FlexValue | null {
  return early === late ? early : null;
}

/** The one value standing for earlier + later when collapsing split mode: the larger of the two. */
export function mergeFlex(early: FlexValue, late: FlexValue): FlexValue {
  if (early === "any" || late === "any") return "any";
  return Math.max(early, late) as FlexValue;
}

export type FlexBrief = { kind: "none" } | { kind: "both"; value: FlexValue } | { kind: "split"; early: FlexValue; late: FlexValue };

/** What the sentence chip shows after the time: nothing, "±½ ש׳", or "½ מוקדם / ¼ מאוחר" (R9U2). */
export function flexBrief(early: FlexValue, late: FlexValue): FlexBrief {
  if (early === late) return early === 0 ? { kind: "none" } : { kind: "both", value: early };
  return { kind: "split", early, late };
}

export type CarChoice = "any" | "luggage" | "specific";

/**
 * The car field is one radio over two classic fields. A request with both a preferred car and
 * luggage shows "specific" (and keeps `luggage` — see `carAlsoLuggage`).
 */
export function carChoiceOf(values: Pick<RequestFormValues, "luggage" | "preferredCarId"> & { preferSpecificCar?: boolean }): CarChoice {
  if (values.preferredCarId || values.preferSpecificCar) return "specific";
  return values.luggage ? "luggage" : "any";
}

export type CarChoiceFields = Pick<RequestFormValues, "luggage" | "preferredCarId"> & { preferSpecificCar: boolean };

/**
 * Writes for choosing an option. Picking "specific" keeps luggage and asks for a car (R9U6: no
 * preselection — the car stays empty, `preferSpecificCar` makes the form refuse an empty one);
 * "any"/"luggage" clear the car.
 */
export function applyCarChoice(choice: CarChoice, current: Pick<RequestFormValues, "luggage" | "preferredCarId">): CarChoiceFields {
  if (choice === "any") return { luggage: false, preferredCarId: "", preferSpecificCar: false };
  if (choice === "luggage") return { luggage: true, preferredCarId: "", preferSpecificCar: false };
  return { luggage: current.luggage, preferredCarId: current.preferredCarId ?? "", preferSpecificCar: true };
}

/** `true` for a request holding both a specific car and the large-luggage requirement. */
export function hasCarAndLuggage(values: Pick<RequestFormValues, "luggage" | "preferredCarId">): boolean {
  return !!values.preferredCarId && values.luggage;
}

/** Which sheet an invalid stage-1 rhf field belongs to, so a failed submit can reopen it. */
/** The sheets of the "אם אין רכב" line (`PlanBLine`). */
export type PlanBSheet = "planBKind" | "planBPlace" | "planBArrive" | "planBPickup" | "planBPickupPlace";
export type SentenceSheet = "trip" | "origin" | "destination" | "day" | "out" | "return" | "who" | "windowHours" | "windowStart" | "windowEnd" | PlanBSheet;
export type InvalidTarget = { kind: "sheet"; sheet: SentenceSheet } | { kind: "row"; row: "description" | "notes" } | { kind: "stage2" };

export function invalidTargetOf(field: string): InvalidTarget | null {
  switch (field) {
    case "destination": return { kind: "sheet", sheet: "destination" };
    case "origin": return { kind: "sheet", sheet: "origin" };
    case "day":
    case "returnDay": return { kind: "sheet", sheet: "day" };
    case "tripType":
    case "tripShape": return { kind: "sheet", sheet: "trip" };
    case "departTime":
    case "arriveByTime": return { kind: "sheet", sheet: "out" };
    case "windowHours": return { kind: "sheet", sheet: "windowHours" };
    case "windowStart": return { kind: "sheet", sheet: "windowStart" };
    case "windowEnd": return { kind: "sheet", sheet: "windowEnd" };
    case "fallback": return { kind: "sheet", sheet: "planBKind" };
    case "altPlace": return { kind: "sheet", sheet: "planBPlace" };
    case "altArriveBy": return { kind: "sheet", sheet: "planBArrive" };
    case "altPickupAt": return { kind: "sheet", sheet: "planBPickup" };
    case "altPickupPlace": return { kind: "sheet", sheet: "planBPickupPlace" };
    case "returnTime":
    case "leaveDestTime":
    case "returnStops": return { kind: "sheet", sheet: "return" };
    case "companions":
    case "children":
    case "extraAdults":
    case "legacyChildSeats":
    case "boosters":
    case "guestNames": return { kind: "sheet", sheet: "who" };
    case "rideDescription": return { kind: "row", row: "description" };
    case "notes": return { kind: "row", row: "notes" };
    case "rideTypeId":
    case "preferredCarId": return { kind: "stage2" };
    default: return null;
  }
}

/** rhf fields shown on stage 1 (the sentence); validated by "המשך" before stage 2 opens. */
export const STAGE_ONE_FIELDS = [
  "tripType", "tripShape", "origin", "destination", "outStops", "day", "returnDay",
  "departTime", "arriveByTime", "returnTime", "leaveDestTime", "returnStops",
  "timeMode", "windowHours", "windowStart", "windowEnd",
  "fallback", "altPlace", "altArriveBy", "altPickupAt", "altPickupPlace",
  "companions", "children", "extraAdults", "legacyChildSeats", "boosters", "guestNames", "rideDescription", "notes",
] as const;

export function isStageOneField(field: string): boolean {
  return (STAGE_ONE_FIELDS as readonly string[]).includes(field);
}

/**
 * "a", "a ו־b", "a, b ו־c" — the last name takes the conjunction as an attached prefix
 * (`and` is the Hebrew "ו" from the dictionary; the helper itself has no Hebrew).
 */
export function joinNames(names: readonly string[], and: string): string {
  const list = names.map((name) => name.trim()).filter(Boolean);
  if (list.length <= 1) return list[0] ?? "";
  const last = list[list.length - 1];
  return `${list.slice(0, -1).join(", ")} ${and}${last}`;
}

/**
 * The who chip's text with unnamed adults (R9B1/R9M1): "A and 2 more" / "A, B and one more adult".
 * `moreLabel` is the already-worded tail ("עוד 2" / "עוד מבוגר/ת", from the dictionary); with no
 * extras this is exactly `joinNames`.
 */
export function joinWho(names: readonly string[], and: string, moreLabel: string | null, andNumber: string = and): string {
  if (!moreLabel) return joinNames(names, and);
  const list = names.map((name) => name.trim()).filter(Boolean);
  if (list.length === 0) return moreLabel;
  return `${list.join(", ")} ${conjoin(and, andNumber, moreLabel)}`;
}

/** The conjunction glued to what follows: `and` + word ("וילד/ה"), `andNumber` + number ("ו־2 ילדים"). */
function conjoin(and: string, andNumber: string, next: string): string {
  return `${/^\d/.test(next) ? andNumber : and}${next}`;
}

export interface UnnamedWhoLabels {
  /** "עוד מבוגר/ת" */
  adultOne: string;
  /** "עוד 2" (needs `n`) */
  adultMany: (n: number) => string;
  /** "עוד ילד/ה" — only unnamed children, one */
  moreChildOne: string;
  /** "ילד/ה" — after a conjunction */
  childOne: string;
  /** "2 ילדים" */
  childMany: (n: number) => string;
  and: string;
  /** The conjunction before a number: "ו־" */
  andNumber: string;
}

/**
 * The who chip's tail for people without a name (REQ §13.112 d): unnamed adults ("עוד מבוגר/ת" / "עוד 2") and
 * unnamed children, a child seat or a booster each ("עוד ילד/ה" / "2 ילדים"): "אני ועוד ילד/ה",
 * "אני, דנה ו־2 ילדים", "אני ועוד מבוגר/ת וילד/ה". `null` when there are none.
 */
export function unnamedWhoLabel(adults: number, children: number, labels: UnnamedWhoLabels): string | null {
  const adultText = adults <= 0 ? null : adults === 1 ? labels.adultOne : labels.adultMany(adults);
  if (children <= 0) return adultText;
  if (!adultText) return children === 1 ? labels.moreChildOne : labels.childMany(children);
  const childText = children === 1 ? labels.childOne : labels.childMany(children);
  return `${adultText} ${conjoin(labels.and, labels.andNumber, childText)}`;
}
