import { describe, expect, it } from "vitest";

import { isAwaitingAnswer, pickPendingProposal, splitMemberProposals } from "./pendingProposal";

const now = Date.parse("2044-01-03T10:00:00Z");
const p = (status: string, expires_at: string | null = null) => ({ status, expires_at });

describe("pickPendingProposal", () => {
  it("returns a sent, unexpired proposal", () => {
    expect(pickPendingProposal([p("withdrawn"), p("sent", "2044-01-04T00:00:00Z")], now)?.status).toBe("sent");
    expect(pickPendingProposal([p("sent")], now)).not.toBeNull();
  });
  it.each(["accepted", "declined", "withdrawn", "applied", "expired", "superseded", "draft"])("never returns %s", (status) => {
    expect(pickPendingProposal([p(status)], now)).toBeNull();
  });
  it("skips a sent proposal past its expiry", () => {
    expect(pickPendingProposal([p("sent", "2044-01-03T09:00:00Z")], now)).toBeNull();
    expect(isAwaitingAnswer({ status: "sent", expiresAt: "2044-01-03T09:00:00Z" }, now)).toBe(false);
  });
});

describe("splitMemberProposals (R5B9)", () => {
  const sent = (response?: string) => ({ status: "sent", expires_at: null, parties: response ? [{ profile_id: "me", response }] : [] });
  it("a sent proposal the member has not answered is pending", () => {
    expect(splitMemberProposals([sent("pending")], "me", now)).toMatchObject({ answeredWaiting: false, pending: { status: "sent" } });
    expect(splitMemberProposals([sent()], "me", now).pending).not.toBeNull();
  });
  it("one the member accepted (others still pending) is answered-and-waiting, never pending", () => {
    const r = splitMemberProposals([sent("accepted")], "me", now);
    expect(r.pending).toBeNull();
    expect(r.answeredWaiting).toBe(true);
  });
  it("another party's answer does not count", () => {
    const other = [{ status: "sent", expires_at: null, parties: [{ profile_id: "host", response: "accepted" }] }];
    expect(splitMemberProposals(other, "me", now)).toMatchObject({ answeredWaiting: false, pending: { status: "sent" } });
  });
});
