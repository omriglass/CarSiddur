// REQ §13.123: with `department_settings.proposals_offline` on, proposals for days that are not
// yet published are agreed on WhatsApp — the board saves a draft and the Sadran marks it
// "סוכם" (agree_proposal_offline) or "לא סוכם" (discard_proposal). Published/live days are unchanged.
import { dateKey } from "@/lib/time";

export interface OfflineWeek {
  phase: string;
  published_days: string[] | null;
}

const PUBLIC_PHASES: ReadonlySet<string> = new Set(["published", "live", "archived"]);

/** Does offline mode apply to `dayIso` (an instant, or a Jerusalem `yyyy-MM-dd` key)? */
export function isOfflineProposalDay(
  proposalsOffline: boolean | null | undefined,
  week: OfflineWeek | null | undefined,
  dayIso: string | null | undefined,
): boolean {
  if (!proposalsOffline || !dayIso) return false;
  if (week && PUBLIC_PHASES.has(week.phase)) return false;
  const key = /^\d{4}-\d{2}-\d{2}$/.test(dayIso) ? dayIso : dateKey(dayIso);
  return !(week?.published_days ?? []).includes(key);
}
