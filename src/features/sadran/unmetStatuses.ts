// src/features/sadran/unmetStatuses.ts
//
// Which `requests.status` values count as "not yet accepted" (owner bug
// report #1, `docs/UX_FLOWS.md` §4.2: the board's `UnmetList` covers "every
// request of the week that has no ride — status submitted/waitlisted/
// proposed/denied"). Before this bug-fix pass, both the board's unmet list
// and the dashboard's "לא שובצו" counter only checked `waitlisted`/`denied`
// — a freshly-submitted week (every request still `submitted`, nothing
// solved yet) showed an empty unmet list and an all-zero dashboard even
// though nothing had been placed. Shared here so the board and dashboard
// always report the same number.
import type { Database } from "@/integrations/supabase/types";

type RequestStatus = Database["public"]["Enums"]["request_status"];

export const UNMET_REQUEST_STATUSES: ReadonlySet<RequestStatus> = new Set<RequestStatus>([
  "submitted",
  "proposed",
  "waitlisted",
  "denied",
]);

export function isUnmetStatus(status: RequestStatus): boolean {
  return UNMET_REQUEST_STATUSES.has(status);
}
