import { datesFrom, weekdayOfDate } from "@/components/dateFieldDates";

/** The Sunday-first grid of `month` (`yyyy-MM`): whole weeks, the other months' days as padding. */
export function monthGridDates(month: string): string[] {
  const first = `${month}-01`;
  const [year, monthNo] = month.split("-").map(Number) as [number, number];
  const daysInMonth = new Date(Date.UTC(year, monthNo, 0)).getUTCDate();
  const lead = weekdayOfDate(first);
  const cells = Math.ceil((lead + daysInMonth) / 7) * 7;
  const start = new Date(Date.UTC(year, monthNo - 1, 1 - lead)).toISOString().slice(0, 10);
  return datesFrom(start, cells);
}
