import { describe, expect, it } from "vitest";

import { isAwaitingAnswer, pickPendingProposal } from "./pendingProposal";

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
