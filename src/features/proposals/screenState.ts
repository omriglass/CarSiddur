import type { ProposalFetchErrorCode, ProposalSummary } from "./api";

/**
 * Pure state classifier for `/p/:token` (UX_FLOWS.md §3.6), factored out of
 * `ProposalTokenPage` so the four screen states are unit-testable without
 * mounting the component (deliverable: "proposal screen states").
 */
export type ProposalScreenState =
  | { kind: "loading" }
  | { kind: "error"; code: ProposalFetchErrorCode }
  | { kind: "answered"; summary: ProposalSummary }
  | { kind: "answerable"; summary: ProposalSummary };

export interface ClassifyProposalStateInput {
  isLoading: boolean;
  errorCode: ProposalFetchErrorCode | null;
  summary: ProposalSummary | undefined;
  /** Set right after a successful POST, before the summary refetches. */
  justAnswered: boolean;
}

const FINAL_STATUSES = new Set(["accepted", "declined", "expired", "applied", "withdrawn"]);

export function classifyProposalScreenState(input: ClassifyProposalStateInput): ProposalScreenState {
  if (input.errorCode) return { kind: "error", code: input.errorCode };
  if (input.isLoading || !input.summary) return { kind: "loading" };
  if (input.justAnswered || FINAL_STATUSES.has(input.summary.status)) {
    return { kind: "answered", summary: input.summary };
  }
  return { kind: "answerable", summary: input.summary };
}
