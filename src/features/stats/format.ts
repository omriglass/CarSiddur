import { format, parseISO } from "date-fns";

/** "62.8%" — one decimal place from a 0..1 rate. Caller wraps the result in `<span dir="ltr">`. */
export function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * "10/09/2026" from a `yyyy-MM-dd` calendar-date string (the `department_stats`
 * range bounds — already a bare date with no time component, so this is pure
 * calendar-day formatting, not a time-zone conversion; CLAUDE.md hard rule 6
 * applies to instants, not to these date-only keys). Caller wraps the result
 * in `<span dir="ltr">`.
 */
export function formatDateDMY(dateKeyValue: string): string {
  return format(parseISO(dateKeyValue), "dd/MM/yyyy");
}

/**
 * "10/09" from a `yyyy-MM-dd` calendar-date string — the weekly chart's
 * x-axis labels, where the year would just be noise (UX_FLOWS.md §5.12).
 * Caller wraps the result in `<span dir="ltr">`.
 */
export function formatDateDM(dateKeyValue: string): string {
  return format(parseISO(dateKeyValue), "dd/MM");
}

/** Fixed-decimal formatting for hours/ride counts/policy scores. Caller wraps the result in `<span dir="ltr">`. */
export function formatDecimal(value: number, digits = 1): string {
  return value.toFixed(digits);
}
