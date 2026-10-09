import type { ProposalMergeView, ProposalSummary } from "./api";

export interface MergePageModel {
  /** `own`: the reader is the guest ("הבקשה שלך"); `guest`: the reader sits on the ride the guest joins. */
  heading: "own" | "guest";
  guestName: string;
  /** The trip line: the guest's legs only (a one-way join never shows a return). */
  trip: { departAt: string | null; returnAt: string | null };
  before: { departAt: string | null; returnAt: string | null };
  after: { departAt: string | null; returnAt: string | null };
  /** The ride's own window (before/after) rather than the guest's times. */
  rideWindow: boolean;
  /** R12B7: the guest's per-reader text — the host/driver's name and which of their own times move (null when nothing moves). */
  hostName: string;
  change: { kind: "depart" | "return"; from: string; to: string } | null;
}

function guestChange(m: ProposalMergeView): MergePageModel["change"] {
  const pick = (kind: "depart" | "return", from: string | null, to: string | null): MergePageModel["change"] =>
    from && to && Date.parse(from) !== Date.parse(to) ? { kind, from, to } : null;
  if (m.leg === "return") return pick("return", m.ownReturnAt, m.guestReturnAt);
  return pick("depart", m.ownDepartAt, m.guestDepartAt) ?? (m.leg === "both" ? pick("return", m.ownReturnAt, m.guestReturnAt) : null);
}

/**
 * REQ §13.116 (R8B8): a merge reads differently per party. The guest sees their own legs and what changes; the host (or a fellow
 * passenger) sees the GUEST's request and the ride's window before/after - never the guest's request as "your request". Null
 * for any other proposal type or an older response without the server's `merge` block (the page then keeps its old rendering).
 */
export function mergePageModel(summary: Pick<ProposalSummary, "type" | "merge" | "request">): MergePageModel | null {
  const m: ProposalMergeView | null | undefined = summary.merge;
  if (summary.type !== "merge" || !m) return null;
  if (m.role === "guest") {
    return {
      heading: "own", guestName: m.guestName,
      trip: { departAt: m.ownDepartAt, returnAt: m.ownReturnAt },
      before: { departAt: m.ownDepartAt, returnAt: m.ownReturnAt },
      after: { departAt: m.guestDepartAt, returnAt: m.guestReturnAt },
      rideWindow: false, hostName: m.driverName, change: guestChange(m),
    };
  }
  return {
    heading: "guest", guestName: m.guestName,
    trip: { departAt: m.guestDepartAt, returnAt: m.guestReturnAt },
    before: { departAt: m.rideStartsAt, returnAt: m.rideEndsAt },
    after: { departAt: m.newStartsAt ?? m.rideStartsAt, returnAt: m.newEndsAt ?? m.rideEndsAt },
    rideWindow: true, hostName: m.driverName, change: null,
  };
}
