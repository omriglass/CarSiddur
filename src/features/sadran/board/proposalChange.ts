// R5U1 (REQ §13.105 e): what a draft / sent proposal changes, stated as old -> new, for the board's proposal
// sheet: the member's times and the car. The wording is the proposal text's own (`timeChangeLine`), and a
// merge reads the joiner's times from the server's `merge_preview` (R5B5), never from a local estimate.
// Pure: no React, no Supabase.
import { he, tv } from "@/i18n/he";
import type { ProposalType } from "@/lib/enums";

import { timeChangeLine } from "../proposals/proposalText";
import type { ServerMergePreview } from "./mergeProposal";

export interface ProposalChangeInput {
  type: ProposalType;
  payload: Record<string, unknown>;
  request: { depart_at: string | null; return_at: string | null } | undefined;
  /** The car the request rides today (null when unplaced) and the car the proposal puts it on (shift) / the host's car (merge). */
  oldCarName?: string | null;
  newCarName?: string | null;
  /** Merge only: `merge_preview` for the proposal's ride / leg. */
  server?: ServerMergePreview | null;
}

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

export function proposalChangeLines(input: ProposalChangeInput): string[] {
  const { type, payload, request } = input;
  if (type !== "shift" && type !== "merge") return [];
  const lines: string[] = [];
  const old = { depart: request?.depart_at, return: request?.return_at };
  if (type === "shift") {
    const span = payload.series_span && typeof payload.series_span === "object" ? (payload.series_span as Record<string, unknown>) : null;
    const next = span ? { depart: str(span.depart_at), return: str(span.return_at) } : { depart: str(payload.depart_at), return: str(payload.return_at) };
    if (next.depart || next.return) lines.push(timeChangeLine(old, next, !!span) || he.sadranProposal.timeUnchanged);
  } else if (input.server) {
    lines.push(timeChangeLine(old, { depart: input.server.joinerDepartAt, return: input.server.joinerReturnAt }) || he.sadranProposal.timeUnchanged);
  }
  if (input.newCarName) {
    lines.push(input.oldCarName && input.oldCarName !== input.newCarName
      ? tv("boardDrafts.changeCar", { new: input.newCarName, old: input.oldCarName })
      : tv("boardDrafts.changeCarSet", { new: input.newCarName }));
  }
  return lines;
}
