import { formatInTimeZone } from "date-fns-tz";

import type { ExcelCell, ExcelSheet } from "@/lib/xlsx";
import { TZ } from "@/lib/time";

import { buildWeekGridSheet, type GridCar, type GridOptions } from "./weekGridSheet";

import type { BoardRide } from "../api";

/** Excel stores wall-clock dates without a zone. Convert to Jerusalem before serializing. */
export function jerusalemExcelDate(instant: string | null | undefined): ExcelCell {
  if (!instant) return null;
  const local = formatInTimeZone(new Date(instant), TZ, "yyyy-MM-dd'T'HH:mm:ss");
  return { excelDate: (Date.parse(`${local}Z`) - Date.UTC(1899, 11, 30)) / 86_400_000 };
}

/**
 * The "board" (סידור) sheet — the on-screen week table (a stacked day table, a column per car,
 * 15-minute rows, one merged block per ride; `weekGridSheet.ts`). Shared by the Sadran's full
 * week export (`sadran/export/weekWorkbook.ts`) and the member-facing archive export
 * (`siddur/export/memberWeekWorkbook.ts`): both read `v_board_rides`, which RLS lets any
 * approved member read for a published/archived day (DATA_MODEL.md §4, `is_week_public()`).
 */
export function buildBoardSheet(rides: readonly BoardRide[], cars: readonly GridCar[], weekStart: string, departmentId: string, options: GridOptions = {}): ExcelSheet {
  return buildWeekGridSheet(rides, cars, weekStart, departmentId, options);
}
