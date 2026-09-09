import { createXlsx } from "@/features/sadran/export/xlsx";

import { carExportSheets } from "./carRows";

import type { CarCareEventWithReporter, CarIssueWithReporter } from "../api";

/** Same writer as `WeekExcelExportButton` (`src/features/sadran/export/xlsx.ts`): stored-zip OpenXML, RTL sheet view, no macros/formulas. */
export function createCarWorkbook(
  issues: readonly CarIssueWithReporter[],
  careEvents: readonly CarCareEventWithReporter[],
): Uint8Array<ArrayBuffer> {
  return createXlsx(carExportSheets(issues, careEvents));
}
