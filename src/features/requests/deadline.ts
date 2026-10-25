import { tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { formatTime } from "@/lib/time";

/**
 * "אפשר להגיש בקשות עד יום ד׳ 28.10 בשעה 17:00" for a week still taking requests (UX_FLOWS §3.5/§3.3a): only while it is
 * `open` and its `close_at` (the Sadran may have moved it, `set_week_close_at`) has not passed — nothing after closing.
 */
export function requestDeadlineText(week: { phase: string; close_at: string } | null | undefined, now = Date.now()): string | null {
  if (!week || week.phase !== "open") return null;
  const closeAt = Date.parse(week.close_at);
  if (!Number.isFinite(closeAt) || closeAt <= now) return null;
  return tv("requestDeadline.line", { day: formatDayDate(closeAt), time: formatTime(new Date(closeAt)) });
}
