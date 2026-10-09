// REQ §13.110 (b) / UX_FLOWS §3.4a: a request end is entered either as the car's own time or as
// the time at the other end ("arrive by" / "leave there at"). The stored car times (`depart_at`,
// `return_at`) are derived on the client from the entered time + the route minutes
// (`route_minutes_preview`), rounded away from the deadline on the 15-minute grid. Pure; the
// anchor label *keys* are returned (never Hebrew) and rendered from `he.requestSentence.*`.
import type { TimeAnchor } from "@/lib/enums";

import { minutesToTime, timeToMinutes } from "./duration";
import { type RushWindows, stretchedMinutesFrom, stretchedMinutesUntil } from "./rushHours";

const DAY_END_MINUTES = 24 * 60 - 1;

export function floorToQuarter(minutes: number): number {
  return Math.floor(minutes / 15) * 15;
}

export function ceilToQuarter(minutes: number): number {
  return Math.ceil(minutes / 15) * 15;
}

/** "HH:MM" for a minute-of-day, clamped to 00:00..23:59. */
export function clampedTime(minutes: number): string {
  return minutesToTime(Math.min(Math.max(minutes, 0), DAY_END_MINUTES));
}

/** Float noise guard before a quarter-hour floor/ceil of a stretched time. */
const tidy = (minutes: number) => Math.round(minutes * 1e6) / 1e6;

/**
 * Clock minutes of a drive of `routeMinutes` base minutes that ends at / starts at `anchorMinute`,
 * stretched by the rush-hour windows (REQ §13.113; none = the plain drive).
 */
function driveBefore(arriveMinute: number, routeMinutes: number, rush: RushWindows): number {
  return rush.length ? stretchedMinutesUntil(arriveMinute, routeMinutes, rush) : routeMinutes;
}
function driveAfter(departMinute: number, routeMinutes: number, rush: RushWindows): number {
  return rush.length ? stretchedMinutesFrom(departMinute, routeMinutes, rush) : routeMinutes;
}

/**
 * Outbound "arrive by": the car leaves one drive earlier, rounded DOWN to 15 minutes. `rush` =
 * the day's rush-hour windows: only the part of the drive inside a window is longer (REQ §13.113).
 */
export function departFromArriveBy(arriveBy: string, routeMinutes: number, rush: RushWindows = []): string {
  const arrive = timeToMinutes(arriveBy);
  return clampedTime(floorToQuarter(tidy(arrive - driveBefore(arrive, routeMinutes, rush))));
}

/** Return "leave there at": the car is home one drive later, rounded UP to 15 minutes (23:59 at most). */
export function returnFromLeaveThere(leaveThere: string, routeMinutes: number, rush: RushWindows = []): string {
  const leave = timeToMinutes(leaveThere);
  return clampedTime(ceilToQuarter(tidy(leave + driveAfter(leave, routeMinutes, rush))));
}

/**
 * Plan B (REQ §13.112): the drop time is stored as an exact `arrive_by`. A member who thinks in
 * "leave at" terms gets `departure + route minutes`, rounded UP to 15 minutes (never later than 23:59).
 */
export function arriveByFromDeparture(departure: string, routeMinutes: number, rush: RushWindows = []): string {
  const leave = timeToMinutes(departure);
  return clampedTime(ceilToQuarter(tidy(leave + driveAfter(leave, routeMinutes, rush))));
}

export interface AnchorFormTimes {
  departAnchor: TimeAnchor;
  arriveByTime?: string;
  departTime?: string;
  returnAnchor: TimeAnchor;
  leaveDestTime?: string;
  returnTime?: string;
}

/** The time the member typed for the outbound end (arrive-by, else the departure). */
export function enteredOutTime(values: Pick<AnchorFormTimes, "departAnchor" | "arriveByTime" | "departTime">): string | undefined {
  return values.departAnchor === "arrive" ? values.arriveByTime : values.departTime;
}

/** The time the member typed for the return end (leave-there, else the arrival home). */
export function enteredReturnTime(values: Pick<AnchorFormTimes, "returnAnchor" | "leaveDestTime" | "returnTime">): string | undefined {
  return values.returnAnchor === "leave" ? values.leaveDestTime : values.returnTime;
}

/**
 * The car times implied by the anchors. `null` route minutes (not known yet) leave a derived
 * time unchanged ("while loading, submit uses the last known value").
 */
export function resolveCarTimes(
  values: AnchorFormTimes,
  routes: { outMinutes: number | null; returnMinutes: number | null },
  rush: RushWindows = [],
): { departTime: string | undefined; returnTime: string | undefined } {
  const departTime =
    values.departAnchor === "arrive" && values.arriveByTime && routes.outMinutes != null
      ? departFromArriveBy(values.arriveByTime, routes.outMinutes, rush)
      : values.departTime;
  const returnTime =
    values.returnAnchor === "leave" && values.leaveDestTime && routes.returnMinutes != null
      ? returnFromLeaveThere(values.leaveDestTime, routes.returnMinutes, rush)
      : values.returnTime;
  return { departTime, returnTime };
}

export type AnchorEstimateKind = "departEstimate" | "arriveEstimate" | "homeEstimate" | "leaveEstimate";

export interface AnchorEstimate {
  kind: AnchorEstimateKind;
  /** "HH:MM" */
  time: string;
  /** Drive minutes shown on the line: the stretched drive when `approx` (rounded). */
  minutes: number;
  /** True when rush hours stretched the drive: the line says "כ־" and "הערכה בלבד" (REQ §13.113). */
  approx: boolean;
}

/**
 * The derived "what the Sadran will see" line under a time (UX_FLOWS §3.4a):
 * out+arrive -> estimated departure, out+leave -> estimated arrival, return+leave -> estimated
 * arrival home, return+arrive -> estimated departure from the destination.
 */
export function endEstimate(end: "out" | "return", anchor: TimeAnchor, entered: string, routeMinutes: number, rush: RushWindows = []): AnchorEstimate {
  const minutes = timeToMinutes(entered);
  // Only the two conversions stretch; the other two lines are fixed-time arithmetic (REQ §13.113).
  if (end === "out" && anchor === "arrive") {
    const drive = driveBefore(minutes, routeMinutes, rush);
    return { kind: "departEstimate", time: departFromArriveBy(entered, routeMinutes, rush), minutes: Math.round(drive), approx: Math.round(drive) !== routeMinutes };
  }
  if (end === "return" && anchor === "leave") {
    const drive = driveAfter(minutes, routeMinutes, rush);
    return { kind: "homeEstimate", time: returnFromLeaveThere(entered, routeMinutes, rush), minutes: Math.round(drive), approx: Math.round(drive) !== routeMinutes };
  }
  if (end === "out") return { kind: "arriveEstimate", time: clampedTime(ceilToQuarter(minutes + routeMinutes)), minutes: routeMinutes, approx: false };
  return { kind: "leaveEstimate", time: clampedTime(floorToQuarter(minutes - routeMinutes)), minutes: routeMinutes, approx: false };
}

export type AnchorLabelKey = "outLeave" | "outArrive" | "returnArrive" | "returnLeave" | "pickupLeave" | "pickupArrive";

/** Which label an end's anchor toggle/chip shows. A הקפצה's return is the pickup. */
export function anchorLabelKey(end: "out" | "return", anchor: TimeAnchor, isPickup: boolean): AnchorLabelKey {
  if (end === "out") return anchor === "arrive" ? "outArrive" : "outLeave";
  if (anchor === "arrive") return isPickup ? "pickupArrive" : "returnArrive";
  return isPickup ? "pickupLeave" : "returnLeave";
}

/**
 * Anchor toggle patch: the typed time stays the typed time, only its meaning changes
 * (leave 08:00 -> arrive-by 08:00). The car time is re-derived by `resolveCarTimes` afterwards.
 */
export function switchOutAnchor(values: Pick<AnchorFormTimes, "departAnchor" | "arriveByTime" | "departTime">, next: TimeAnchor): Pick<AnchorFormTimes, "departAnchor" | "arriveByTime" | "departTime"> {
  if (next === values.departAnchor) return values;
  const entered = enteredOutTime(values);
  return next === "arrive"
    ? { departAnchor: "arrive", arriveByTime: entered, departTime: values.departTime }
    : { departAnchor: "leave", arriveByTime: undefined, departTime: entered };
}

export function switchReturnAnchor(values: Pick<AnchorFormTimes, "returnAnchor" | "leaveDestTime" | "returnTime">, next: TimeAnchor): Pick<AnchorFormTimes, "returnAnchor" | "leaveDestTime" | "returnTime"> {
  if (next === values.returnAnchor) return values;
  const entered = enteredReturnTime(values);
  return next === "leave"
    ? { returnAnchor: "leave", leaveDestTime: entered, returnTime: values.returnTime }
    : { returnAnchor: "arrive", leaveDestTime: undefined, returnTime: entered };
}

/**
 * Form anchor fields from a stored request (edit prefill) or a template suggestion. A row whose
 * anchor has no matching typed instant falls back to the default (the car time is the typed one).
 */
export function anchorFormFields(
  row: { departAnchor?: TimeAnchor | null; arriveBy?: string | null; returnAnchor?: TimeAnchor | null; leaveDestAt?: string | null },
  timeOf: (instant: string) => string,
): Pick<AnchorFormTimes, "departAnchor" | "arriveByTime" | "returnAnchor" | "leaveDestTime"> {
  const arrive = row.departAnchor === "arrive" && row.arriveBy;
  const leave = row.returnAnchor === "leave" && row.leaveDestAt;
  return {
    departAnchor: arrive ? "arrive" : "leave",
    arriveByTime: arrive ? timeOf(row.arriveBy as string) : undefined,
    returnAnchor: leave ? "leave" : "arrive",
    leaveDestTime: leave ? timeOf(row.leaveDestAt as string) : undefined,
  };
}
