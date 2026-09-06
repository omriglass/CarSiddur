import { describe, expect, it } from "vitest";

import { classifyProposalScreenState } from "./screenState";

import type { ProposalSummary } from "./api";

const SUMMARY: ProposalSummary = {
  proposalId: "p1",
  type: "shift",
  status: "sent",
  reasonHe: "בשעה 09:00 כל הרכבים תפוסים",
  expiresAt: "2026-09-16T17:00:00Z",
  payload: {},
  request: {
    id: "r1",
    destination: "עפולה",
    rideType: "בריאות",
    departAt: "2026-09-15T06:00:00Z",
    returnAt: "2026-09-15T10:00:00Z",
    adults: 1,
    childSeats: 0,
    boosters: 0,
  },
  parties: [],
};

describe("classifyProposalScreenState", () => {
  it("is 'loading' while the query is in flight", () => {
    expect(classifyProposalScreenState({ isLoading: true, errorCode: null, summary: undefined, justAnswered: false })).toEqual({
      kind: "loading",
    });
  });

  it("is 'error' with the mapped code on a fetch failure (404/410/429)", () => {
    expect(
      classifyProposalScreenState({ isLoading: false, errorCode: "invalid_token", summary: undefined, justAnswered: false }),
    ).toEqual({ kind: "error", code: "invalid_token" });
    expect(
      classifyProposalScreenState({ isLoading: false, errorCode: "expired", summary: undefined, justAnswered: false }),
    ).toEqual({ kind: "error", code: "expired" });
    expect(
      classifyProposalScreenState({ isLoading: false, errorCode: "rate_limited", summary: undefined, justAnswered: false }),
    ).toEqual({ kind: "error", code: "rate_limited" });
  });

  it("is 'answerable' for a 'sent' proposal not yet answered", () => {
    expect(classifyProposalScreenState({ isLoading: false, errorCode: null, summary: SUMMARY, justAnswered: false })).toEqual({
      kind: "answerable",
      summary: SUMMARY,
    });
  });

  it("is 'answered' immediately after a successful POST, even before refetch", () => {
    expect(classifyProposalScreenState({ isLoading: false, errorCode: null, summary: SUMMARY, justAnswered: true })).toEqual({
      kind: "answered",
      summary: SUMMARY,
    });
  });

  it.each(["accepted", "declined", "expired", "applied", "withdrawn"] as const)(
    "is 'answered' for a proposal already in a final status ('%s')",
    (status) => {
      const summary = { ...SUMMARY, status };
      expect(classifyProposalScreenState({ isLoading: false, errorCode: null, summary, justAnswered: false })).toEqual({
        kind: "answered",
        summary,
      });
    },
  );
});
