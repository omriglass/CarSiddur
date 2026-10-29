import { tv } from "@/i18n/he";

/** "d.M" of a `YYYY-MM-DD` date key plus `days` (plain calendar arithmetic, no time zone involved). */
function dayMonth(dateKey: string, days: number): { label: string; year: number } {
  const [year = 0, month = 1, day = 1] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return { label: `${date.getUTCDate()}.${date.getUTCMonth() + 1}`, year: date.getUTCFullYear() };
}

/** The week workbook's file name (owner 2026-10-29): "סידור נבו - 1.11-7.11 (2026)" — Sunday to Saturday, the Sunday's year. */
export function weekExportFileName(departmentName: string | null | undefined, weekStart: string): string {
  const from = dayMonth(weekStart, 0);
  const to = dayMonth(weekStart, 6);
  const name = tv("excelExport.fileName", { department: departmentName ?? "", from: from.label, to: to.label, year: String(from.year) });
  // Characters no file system accepts (a department name could hold one).
  return `${name.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim()}.xlsx`;
}
