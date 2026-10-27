import { tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";

import type { WaitlistGroup, WaitlistGroupHold, WaitlistGroupMember } from "./types";

export interface GroupSummaryItem {
  requestId: string;
  /** "שחר" or "שחר עם עמוס". */
  who: string;
  destination: string;
  start: string;
  end: string;
}

/**
 * REQ §13.157: the sheet's one line for an open discussion — every undecided member with whoever rides with them,
 * where to and when ("שחר עם עמוס לבנימינה 09:00–13:00, או ענת לחיפה 10:00–14:00"); `GroupSummary` renders it.
 */
export function groupSummaryItems(members: readonly WaitlistGroupMember[]): GroupSummaryItem[] {
  return members
    .filter((member) => member.chosen === null)
    .map((member) => ({
      requestId: member.request_id,
      who: member.companions.length > 0 ? tv("waitlist.summaryWho", { name: member.name, companions: member.companions.join(", ") }) : member.name,
      destination: member.destination,
      start: formatTime(new Date(member.depart_at)),
      end: formatTime(new Date(member.return_at)),
    }));
}

/**
 * REQ §13.157: the hours a newcomer may ask for to join this discussion — the free gap around the group of the
 * cars it holds (`waitlist_group_holds`), or null when it holds none.
 */
export function groupJoinWindow(groupId: string, holds: readonly WaitlistGroupHold[]): { from: string; until: string } | null {
  const [first, ...rest] = holds.filter((hold) => hold.group_id === groupId);
  if (!first) return null;
  return rest.reduce(
    (span, hold) => ({
      from: Date.parse(hold.gap_from) < Date.parse(span.from) ? hold.gap_from : span.from,
      until: Date.parse(hold.gap_until) > Date.parse(span.until) ? hold.gap_until : span.until,
    }),
    { from: first.gap_from, until: first.gap_until },
  );
}

export interface JoinableRequest {
  id: string;
  requesterId?: string;
  filedById?: string | null;
  status: string;
  statusReason: string | null;
  departAt: string | null;
  returnAt: string | null;
  weekStart: string;
}

/** REQ §13.157: the viewer's own waiting request that could join this discussion in one tap (overlapping its hours), if any. */
export function myJoinableRequest<T extends JoinableRequest>(group: WaitlistGroup, requests: readonly T[], profileId: string | undefined): T | null {
  if (!profileId || group.members.some((member) => member.profile_id === profileId && member.chosen === null)) return null;
  const memberIds = new Set(group.members.map((member) => member.request_id));
  return requests.find((request) =>
    request.weekStart === group.week_start && request.status === "waitlisted" && request.statusReason !== "WAITLISTED_CONTESTED"
    && (request.requesterId === profileId || request.filedById === profileId) && !memberIds.has(request.id)
    && !!request.departAt && !!request.returnAt
    && Date.parse(request.departAt) < Date.parse(group.ends_at) && Date.parse(request.returnAt) > Date.parse(group.starts_at),
  ) ?? null;
}

/** REQ §13.157: a request filed to join a discussion must lie inside its free hours and overlap the discussion. */
export function fitsJoinWindow(
  departAt: string | null | undefined,
  returnAt: string | null | undefined,
  group: Pick<WaitlistGroup, "starts_at" | "ends_at">,
  window: { from: string; until: string },
): boolean {
  if (!departAt || !returnAt) return false;
  const depart = Date.parse(departAt);
  const ret = Date.parse(returnAt);
  return depart >= Date.parse(window.from) && ret <= Date.parse(window.until)
    && depart < Date.parse(group.ends_at) && ret > Date.parse(group.starts_at);
}
