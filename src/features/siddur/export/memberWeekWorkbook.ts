import { buildBoardSheet } from "@/features/rides/export/weekWorkbook";
import { createXlsx, type ExcelSheet } from "@/lib/xlsx";

import type { BoardRide } from "../api";

export interface MemberWeekExportData {
  departmentId: string;
  weekStart: string;
  rides: BoardRide[];
  cars: { id: string; name: string; type?: string | null; status?: string | null }[];
  homeDestinationId?: string | null;
  boardStartTime?: string | null;
}

/**
 * Member-facing week export (Archive of past siddurim, owner decision
 * 2026-09-10): any approved member may export a published/archived week's
 * workbook, but the Sadran-only "requests" and "scores" sheets of the full
 * export (`weekExportSheets`, `src/features/sadran/export/weekWorkbook.ts`)
 * read from tables RLS restricts to the Sadran/Admin — the plain `requests`
 * table (a member only sees their own/companion/publicly-served rows, not
 * everyone's — `requests_select`, DATA_MODEL.md §4) and `siddur_versions`'
 * policy-score snapshot (`can_manage_week()`-only). This keeps only the
 * "board" (סידור) sheet, built from the same `v_board_rides` rows the
 * Sadran export uses — RLS already lets any approved member read those for
 * a published/archived day (`is_week_public()`/`is_day_public()`).
 */
export function memberWeekExportSheets(data: MemberWeekExportData): ExcelSheet[] {
  return [buildBoardSheet(data.rides, data.cars, data.weekStart, data.departmentId, { homeDestinationId: data.homeDestinationId, boardStartTime: data.boardStartTime })];
}

export function createMemberWeekWorkbook(data: MemberWeekExportData): Uint8Array<ArrayBuffer> {
  return createXlsx(memberWeekExportSheets(data));
}
