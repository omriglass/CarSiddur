// REQ item 246 (LT1): the request form's stop hours — a fixed hour (arrive by / leave at) with its
// flexibility and an optional stay per stop — and the bridge from the form to the one timing rule
// (`src/lib/stopSchedule.ts`; SQL twin `request_schedule`). Hours are kept per leg and place
// (`stopHoursKey`), so every writer of `outStops`/`returnStops` keeps them attached to their place.
// Pure.
import type { DestinationValue } from "@/components/DestinationCombobox";
import { schedule, type Schedule, type SchedulePoint, type StopAnchor } from "@/lib/stopSchedule";

import type { RoutePreviewPoint } from "./api";
import { timeToMinutes } from "./duration";
import type { FlexValue } from "./mapper";

export const STOP_FLEX_MINUTES = [0, 10, 15, 30, 60] as const;
export const STOP_STAY_MINUTES = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 360, 420, 480] as const;

export interface StopHoursValue {
  anchor: StopAnchor | null;
  /** "HH:MM" on the request day; null without a fixed hour. */
  time: string | null;
  flex: number;
  /** Minutes there as the member gave them; null = worked out. */
  stay: number | null;
}

export const NO_STOP_HOURS: StopHoursValue = { anchor: null, time: null, flex: 0, stay: null };

export type StopHoursRecord = Record<string, StopHoursValue>;

export type StopLeg = "out" | "return";

export function stopHoursKey(leg: StopLeg, value: DestinationValue): string {
  return "presetId" in value ? `${leg}|p:${value.presetId}` : `${leg}|t:${value.freeText.trim().toLowerCase()}`;
}

export function stopHoursOf(record: StopHoursRecord | undefined, leg: StopLeg, value: DestinationValue): StopHoursValue {
  return record?.[stopHoursKey(leg, value)] ?? NO_STOP_HOURS;
}

export function isEmptyStopHours(hours: StopHoursValue): boolean {
  return hours.anchor === null && hours.stay === null;
}

export function withStopHours(record: StopHoursRecord | undefined, leg: StopLeg, value: DestinationValue, hours: StopHoursValue): StopHoursRecord {
  const next = { ...(record ?? {}) };
  const key = stopHoursKey(leg, value);
  if (isEmptyStopHours(hours)) delete next[key];
  else next[key] = { ...hours, flex: hours.anchor ? hours.flex : 0, time: hours.anchor ? hours.time : null };
  return next;
}

/** Any stop on an active leg carries a fixed hour. */
export function hasFixedStopHours(values: StopRouteValues): boolean {
  return [...values.outStops.map((v) => stopHoursOf(values.stopHours, "out", v)),
    ...(values.hasReturn ? values.returnStops.map((v) => stopHoursOf(values.stopHours, "return", v)) : [])]
    .some((h) => h.anchor !== null);
}

/** `submit_request` stop fields (always sent by the form, so the server compares and checks them). `toIso` turns "HH:MM" on the request day into an instant. */
export function stopHoursPayload(hours: StopHoursValue, toIso: (time: string) => string): { fixed_anchor: StopAnchor | null; fixed_at: string | null; flex_minutes: number; stay_minutes: number | null } {
  const fixed = hours.anchor !== null && !!hours.time;
  return {
    fixed_anchor: fixed ? hours.anchor : null,
    fixed_at: fixed ? toIso(hours.time!) : null,
    flex_minutes: fixed ? hours.flex : 0,
    stay_minutes: hours.stay,
  };
}

export interface StopRouteValues {
  origin: DestinationValue;
  destination: DestinationValue;
  outStops: readonly DestinationValue[];
  returnStops: readonly DestinationValue[];
  stopHours?: StopHoursRecord;
  hasReturn: boolean;
  /** "leave" = the departure from home is the member's own (fixed); "arrive" = arrive by at the destination. */
  departAnchor: StopAnchor;
  departTime?: string;
  arriveByTime?: string;
  flexDepartLate?: FlexValue;
  /** "leave" = leave the destination at (fixed); "arrive" = home by (fixed). */
  returnAnchor: StopAnchor;
  returnTime?: string;
  leaveDestTime?: string;
  flexReturnLate?: FlexValue;
}

/** Keys of the schedule points (same as SQL `request_schedule`). */
export const pointKey = {
  start: "start",
  dest: "dest",
  back: "back",
  end: "end",
  stop: (leg: StopLeg, position: number) => `${leg}:${position}`,
} as const;

const toPreview = (v: DestinationValue): RoutePreviewPoint =>
  "presetId" in v ? { place_id: v.presetId, place_text: null } : { place_id: null, place_text: v.freeText };
const placeOf = (v: DestinationValue) => ("presetId" in v ? `p:${v.presetId}` : `t:${v.freeText.trim().toLowerCase()}`);
const flexMinutes = (v: FlexValue | undefined) => (v === "any" ? 24 * 60 : v ?? 0);
const fixedAt = (time: string | undefined, anchor: StopAnchor, flex: number) =>
  time ? { anchor, at: timeToMinutes(time), flex } : null;

/** The route as schedule points + the places to price each hop (`route_hops_preview`). */
export function stopRoutePoints(values: StopRouteValues): { points: SchedulePoint[]; preview: RoutePreviewPoint[] } {
  const points: SchedulePoint[] = [];
  const preview: RoutePreviewPoint[] = [];
  const add = (p: SchedulePoint, at: DestinationValue) => { points.push(p); preview.push(toPreview(at)); };
  const stopPoint = (leg: StopLeg, v: DestinationValue, i: number) => {
    const h = stopHoursOf(values.stopHours, leg, v);
    add({ key: pointKey.stop(leg, i + 1), place: placeOf(v), kind: "stop", stay: h.stay,
      fixed: h.anchor && h.time ? { anchor: h.anchor, at: timeToMinutes(h.time), flex: h.flex } : null }, v);
  };
  add({ key: pointKey.start, place: placeOf(values.origin), kind: "start", stay: null,
    fixed: values.departAnchor === "leave" ? fixedAt(values.departTime, "leave", 0) : null }, values.origin);
  values.outStops.forEach((v, i) => stopPoint("out", v, i));
  add({ key: pointKey.dest, place: placeOf(values.destination), kind: values.hasReturn ? "destArrive" : "end", stay: null,
    fixed: values.departAnchor === "arrive" ? fixedAt(values.arriveByTime, "arrive", flexMinutes(values.flexDepartLate)) : null }, values.destination);
  if (values.hasReturn) {
    add({ key: pointKey.back, place: placeOf(values.destination), kind: "destLeave", stay: null,
      fixed: values.returnAnchor === "leave" ? fixedAt(values.leaveDestTime, "leave", flexMinutes(values.flexReturnLate)) : null }, values.destination);
    values.returnStops.forEach((v, i) => stopPoint("return", v, i));
    add({ key: pointKey.end, place: placeOf(values.origin), kind: "end", stay: null,
      fixed: values.returnAnchor === "arrive" ? fixedAt(values.returnTime, "arrive", flexMinutes(values.flexReturnLate)) : null }, values.origin);
  }
  return { points, preview };
}

export interface HopMinutes {
  hops: readonly number[];
  stopMinutes: number;
}

/** Hop minutes keyed "from>to" for a priced sequence of places (`route_hops_preview` over them). */
export function hopPairs(places: readonly string[], hops: readonly number[]): Map<string, number> {
  const byPair = new Map<string, number>();
  places.forEach((place, i) => { if (i > 0) byPair.set(`${places[i - 1]}>${place}`, hops[i - 1] ?? 60); });
  return byPair;
}

/** A travel function over priced pairs; the same place is 0, an unpriced pair 60 (REQ §13.109). */
export function pairTravel(...maps: readonly Map<string, number>[]): (from: string, to: string) => number {
  return (from, to) => {
    if (from === to) return 0;
    for (const map of maps) { const m = map.get(`${from}>${to}`); if (m !== undefined) return m; }
    return 60;
  };
}

/** A travel function over the points' consecutive hops (the only hops the rule asks for). */
export function hopTravel(points: readonly SchedulePoint[], hops: HopMinutes): (from: string, to: string) => number {
  return pairTravel(hopPairs(points.map((p) => p.place), hops.hops));
}

/** The place key the schedule uses for a form place. */
export const schedulePlace = (v: DestinationValue) => placeOf(v);

export function scheduleOfRoute(points: readonly SchedulePoint[], hops: HopMinutes, defaultStart: number): Schedule {
  return schedule(points, { travel: hopTravel(points, hops), stopMinutes: hops.stopMinutes, defaultStart });
}
