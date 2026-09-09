import { jerusalemExcelDate } from "@/features/sadran/export/weekWorkbook";
import type { ExcelCell, ExcelSheet } from "@/features/sadran/export/xlsx";
import { he } from "@/i18n/he";

import { parseTireStates, type TireStates } from "../lib/history";

import type { CarCareEventWithReporter, CarIssueWithReporter } from "../api";

import type { Database } from "@/integrations/supabase/types";

type TireState = Database["public"]["Enums"]["tire_state"];

const copy = he.carPage;

const TIRE_STATE_LABEL: Record<TireState, string> = {
  ok: copy.exportTireStateOk,
  low: copy.exportTireStateLow,
  very_low: copy.exportTireStateVeryLow,
};

function reporterName(row: { reported_by: string; reported_by_profile: { full_name: string } | null }): string {
  return row.reported_by_profile?.full_name ?? row.reported_by;
}

function tireCell(tires: TireStates | null, key: keyof TireStates): ExcelCell {
  return tires ? TIRE_STATE_LABEL[tires[key]] : null;
}

/** "תקלות" sheet rows — header row first, one data row per `car_issues` history entry. */
export function issueRows(issues: readonly CarIssueWithReporter[]): ExcelCell[][] {
  return [
    [copy.exportColumnDate, copy.exportColumnReporter, copy.exportColumnCategory, copy.exportColumnDescription, copy.exportColumnStatus, copy.exportColumnUnsafe],
    ...issues.map((issue) => [
      jerusalemExcelDate(issue.created_at),
      reporterName(issue),
      issue.category ? he.carCare.category[issue.category] : "",
      issue.description,
      issue.status === "open" ? he.adminIssues.statusOpen : he.adminIssues.statusResolved,
      issue.is_unsafe ? he.adminIssues.unsafe : "",
    ]),
  ];
}

function tireFillEvents(events: readonly CarCareEventWithReporter[]): readonly CarCareEventWithReporter[] {
  return events.filter((event) => event.kind === "tire_fill");
}

function washEvents(events: readonly CarCareEventWithReporter[]): readonly CarCareEventWithReporter[] {
  return events.filter((event) => event.kind === "wash");
}

/** "מילוי אוויר" sheet rows — one row per tire-fill log, five tire-position columns plus a note. */
export function tireFillRows(events: readonly CarCareEventWithReporter[]): ExcelCell[][] {
  return [
    [
      copy.exportColumnDate, copy.exportColumnReporter,
      copy.exportColumnTireFrontLeft, copy.exportColumnTireFrontRight, copy.exportColumnTireRearLeft, copy.exportColumnTireRearRight, copy.exportColumnTireSpare,
      copy.exportColumnNote,
    ],
    ...tireFillEvents(events).map((event) => {
      const tires = parseTireStates(event.tires);
      return [
        jerusalemExcelDate(event.created_at),
        reporterName(event),
        tireCell(tires, "front_left"), tireCell(tires, "front_right"), tireCell(tires, "rear_left"), tireCell(tires, "rear_right"), tireCell(tires, "spare"),
        event.note,
      ];
    }),
  ];
}

/** "שטיפות" sheet rows — date and reporter only, no further input on a wash log. */
export function washRows(events: readonly CarCareEventWithReporter[]): ExcelCell[][] {
  return [
    [copy.exportColumnDate, copy.exportColumnReporter],
    ...washEvents(events).map((event) => [jerusalemExcelDate(event.created_at), reporterName(event)]),
  ];
}

export function carExportSheets(
  issues: readonly CarIssueWithReporter[],
  careEvents: readonly CarCareEventWithReporter[],
): ExcelSheet[] {
  return [
    { name: copy.exportIssuesSheet, rows: issueRows(issues) },
    { name: copy.exportTireFillsSheet, rows: tireFillRows(careEvents) },
    { name: copy.exportWashesSheet, rows: washRows(careEvents) },
  ];
}
