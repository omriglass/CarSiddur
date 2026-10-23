import { t, tv } from "@/i18n/he";

type CountKey = "dayProposals" | "dayUpdates" | "weekUpdates";

/** Send-all dialog counts: Hebrew says "הצעה אחת", not "1 הצעות" (R14 follow-up). */
export function sendAllCount(key: CountKey, count: number): string {
  return count === 1 ? t(`sendAll.${key}One`) : tv(`sendAll.${key}`, { count: String(count) });
}
