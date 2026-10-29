import type { ProposalFetchErrorCode, ProposalSummary } from "./api";

/**
 * Pure state classifier for `/p/:token` (UX_FLOWS.md §3.6), factored out of
 * `ProposalTokenPage` so the screen states are unit-testable without
 * mounting the component (deliverable: "proposal screen states").
 * `ended` (O28-1, REQ §13.160): the proposal was withdrawn by the Sadran or expired —
 * `superseded` when a newer proposal on the same request replaced it.
 */
export type ProposalScreenState =
  | { kind: "loading" }
  | { kind: "error"; code: ProposalFetchErrorCode }
  | { kind: "ended"; reason: "withdrawn" | "expired"; superseded: boolean }
  | { kind: "answered"; summary: ProposalSummary }
  | { kind: "answerable"; summary: ProposalSummary };

export interface ClassifyProposalStateInput {
  isLoading: boolean;
  errorCode: ProposalFetchErrorCode | null;
  summary: ProposalSummary | undefined;
  /** Set right after a successful POST, before the summary refetches. */
  justAnswered: boolean;
}

const FINAL_STATUSES = new Set(["accepted", "declined", "applied"]);

export function classifyProposalScreenState(input: ClassifyProposalStateInput): ProposalScreenState {
  if (input.errorCode) return { kind: "error", code: input.errorCode };
  if (input.isLoading || !input.summary) return { kind: "loading" };
  const { status } = input.summary;
  if (!input.justAnswered && (status === "withdrawn" || status === "expired")) {
    return { kind: "ended", reason: status, superseded: input.summary.superseded === true };
  }
  // R5B9: this reader already answered (the proposal still waits for the other parties) - nothing to answer, not "pending".
  const answeredByYou = input.summary.parties.some((party) => party.isYou && party.response !== "pending");
  if (input.justAnswered || answeredByYou || FINAL_STATUSES.has(input.summary.status)) {
    return { kind: "answered", summary: input.summary };
  }
  return { kind: "answerable", summary: input.summary };
}
