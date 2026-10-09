import { fromZonedTime } from "date-fns-tz";

import { formatDayDate } from "@/lib/dayLabels";
import { dateKey, formatTime, TZ } from "@/lib/time";

/**
 * Scheduled car maintenance (REQ §13.114) — pure helpers shared by the siddur/board grid, the car page, the
 * cars list and the period dialog. No React, no Supabase.
 */
export interface MaintenancePeriod {
  id: string;
  car_id: string;
  starts_at: string;
  ends_at: string;
  reason: string;
}

const QUARTER_MS = 15 * 60_000;

/** The period shown as "the next one": the earliest that has not ended yet (a running one counts). */
export function nextMaintenance<T extends Pick<MaintenancePeriod, "car_id" | "starts_at" | "ends_at">>(
  blocks: readonly T[],
  carId: string,
  nowMs: number,
): T | undefined {
  return blocks
    .filter((b) => b.car_id === carId && Date.parse(b.ends_at) > nowMs)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))[0];
}

/** Left-to-right isolate (LRI … PDI): a time range keeps its digits order inside Hebrew (right-to-left) text, in plain strings too. */
const ltr = (text: string) => `\u2066${text}\u2069`;

/** "ד׳ 12.11 10:00–19:00" for one day, "ד׳ 12.11 10:00 – ה׳ 13.11 19:00" across days (Asia/Jerusalem); times are LTR-isolated. */
export function formatMaintenanceRange(startsAt: string, endsAt: string): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (dateKey(start) === dateKey(end)) return `${formatDayDate(start)} ${ltr(`${formatTime(start)}–${formatTime(end)}`)}`;
  return `${formatDayDate(start)} ${ltr(formatTime(start))} – ${formatDayDate(end)} ${ltr(formatTime(end))}`;
}

export interface MaintenanceDaySlice {
  /** Minutes from the day's local midnight; may be < 0 or > 1440 when the period spills over this day. */
  startMinutes: number;
  endMinutes: number;
  clippedStart: boolean;
  clippedEnd: boolean;
}

/** The part of a period on one local day (`day` = "yyyy-MM-dd"), or null when it does not touch the day. */
export function maintenanceDaySlice(period: Pick<MaintenancePeriod, "starts_at" | "ends_at">, day: string): MaintenanceDaySlice | null {
  const dayStart = fromZonedTime(`${day}T00:00:00`, TZ).getTime();
  const startMinutes = (Date.parse(period.starts_at) - dayStart) / 60_000;
  const endMinutes = (Date.parse(period.ends_at) - dayStart) / 60_000;
  if (!(startMinutes < 1440 && endMinutes > 0)) return null;
  return { startMinutes, endMinutes, clippedStart: startMinutes < 0, clippedEnd: endMinutes > 1440 };
}

export type MaintenanceEdge = "move" | "start" | "end";

/** The period after dragging it on the grid: `delta` minutes (15-minute multiples); never shorter than 15 minutes. */
export function shiftMaintenance(
  period: Pick<MaintenancePeriod, "starts_at" | "ends_at">,
  edge: MaintenanceEdge,
  deltaMinutes: number,
): { startsAt: string; endsAt: string } {
  const start = Date.parse(period.starts_at);
  const end = Date.parse(period.ends_at);
  const delta = deltaMinutes * 60_000;
  let nextStart = edge === "end" ? start : start + delta;
  let nextEnd = edge === "start" ? end : end + delta;
  if (nextEnd - nextStart < QUARTER_MS) {
    if (edge === "start") nextStart = nextEnd - QUARTER_MS;
    else nextEnd = nextStart + QUARTER_MS;
  }
  return { startsAt: new Date(nextStart).toISOString(), endsAt: new Date(nextEnd).toISOString() };
}

/**
 * Who may move / resize / remove a period — mirror of the server rule (`_can_edit_car_maintenance`): an admin,
 * the department's Sadranim, and the car's CURRENT responsible person. The server re-checks every call.
 */
export function canEditMaintenance(input: {
  isAdmin: boolean;
  isDepartmentSadran: boolean;
  profileId: string | undefined;
  carResponsibleId: string | null | undefined;
}): boolean {
  if (input.isAdmin || input.isDepartmentSadran) return true;
  return !!input.profileId && !!input.carResponsibleId && input.profileId === input.carResponsibleId;
}
