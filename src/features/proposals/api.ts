import { env } from "@/lib/env";
import { rpc } from "@/lib/rpc";
import { supabase } from "@/integrations/supabase/client";

import type { Database, Json } from "@/integrations/supabase/types";

/**
 * The only file in the `proposals` feature that calls `.rpc` — and, for the
 * `/p/:token` deep link (no session required, ARCHITECTURE §8), the
 * `answer-proposal` edge function directly via `fetch`.
 */
export type AnswerChannel = Database["public"]["Enums"]["answer_channel"];

export interface ProposalPartySummary {
  profileId: string;
  fullName: string;
  response: "pending" | "accepted" | "declined";
  isYou: boolean;
}

export interface ProposalRequestSummary {
  id: string;
  destination: string | null;
  rideType: string | null;
  departAt: string | null;
  returnAt: string | null;
  adults: number;
  childSeats: number;
  boosters: number;
}

export interface ProposalSummary {
  proposalId: string;
  type: Database["public"]["Enums"]["proposal_type"];
  status: Database["public"]["Enums"]["proposal_status"];
  reasonHe: string;
  expiresAt: string;
  payload: unknown;
  // The proposal's own week key (`answer-proposal/index.ts`'s `buildSummary()`), so
  // `ProposalTokenPage.tsx` can resolve the Sadran contact for the WhatsApp button
  // (`useSadranContactQuery`) for a signed-in member without a second round trip. Optional:
  // older cached responses/tests may omit them, and the button stays hidden without a session.
  departmentId?: string;
  weekStart?: string;
  request: ProposalRequestSummary | null;
  parties: ProposalPartySummary[];
}

export type ProposalFetchErrorCode = "invalid_token" | "expired" | "rate_limited" | "unknown";

export class ProposalFetchError extends Error {
  readonly code: ProposalFetchErrorCode;
  constructor(code: ProposalFetchErrorCode) {
    super(code);
    this.code = code;
  }
}

const ANSWER_PROPOSAL_FUNCTION_URL = `${env.VITE_SUPABASE_URL}/functions/v1/answer-proposal`;

function codeForStatus(status: number): ProposalFetchErrorCode {
  if (status === 404) return "invalid_token";
  if (status === 410) return "expired";
  if (status === 429) return "rate_limited";
  return "unknown";
}

/**
 * GET summary for the `/p/:token` screen — works without a session. The
 * edge function (`supabase/functions/answer-proposal/index.ts`) currently
 * returns the fields flattened (`proposalId`, `type`, `status`, …) rather
 * than nested under a `proposal` key; this reads that shape directly and is
 * the single place to adjust if the function's response shape changes.
 */
export async function fetchProposalSummary(token: string): Promise<ProposalSummary> {
  const url = new URL(ANSWER_PROPOSAL_FUNCTION_URL);
  url.searchParams.set("token", token);

  const response = await fetch(url.toString(), {
    headers: { apikey: env.VITE_SUPABASE_ANON_KEY },
  });
  if (!response.ok) {
    throw new ProposalFetchError(codeForStatus(response.status));
  }
  return (await response.json()) as ProposalSummary;
}

export interface AnswerProposalTokenResult {
  proposalId: string;
  accepted: boolean;
}

/**
 * POST an answer through the edge function (no session needed; attaches one if present).
 * `optOut` (Stage 3 hardening fix #3) is the deny/external variant's freed-slot checkbox —
 * plumbed through to the edge function since a no-session caller can't call the
 * owner/Sadran-gated `set_freed_slot_opt_out` RPC directly (see `ProposalTokenPage.tsx`,
 * which uses that RPC instead when a session exists).
 */
export async function answerProposalViaToken(
  token: string,
  answer: "accepted" | "declined",
  note?: string,
  optOut?: boolean,
): Promise<AnswerProposalTokenResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;

  const response = await fetch(ANSWER_PROPOSAL_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.VITE_SUPABASE_ANON_KEY,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ token, answer, note, optOut }),
  });
  if (!response.ok) {
    throw new ProposalFetchError(codeForStatus(response.status));
  }
  const data = (await response.json()) as { proposal_id?: string; proposalId?: string; accepted?: boolean };
  return {
    proposalId: data.proposal_id ?? data.proposalId ?? "",
    accepted: !!data.accepted,
  };
}

export interface AnswerProposalInput {
  token: string;
  accept: boolean;
  note?: string;
  via?: AnswerChannel;
}

/** `/p/:token` answers without sign-in (ARCHITECTURE.md §8, CLAUDE.md decision 9). */
export async function answerProposal(input: AnswerProposalInput): Promise<Json> {
  return rpc("answer_proposal", {
    p_token: input.token,
    p_accept: input.accept,
    p_note: input.note,
    p_via: input.via,
  });
}

/**
 * The assigned Sadran(s)' name + phone, for the "talk to the sadran on
 * WhatsApp" button on `/p/:token` (UX_FLOWS.md §3.6). Backed by
 * `sadran_contact_of(department_id, week_start)`
 * (`supabase/migrations/20260909095000_add_sadran_contact_rpc.sql`), which
 * requires a real session (`is_approved() and member_of(department_id)`) —
 * never callable from the public, token-only `answer-proposal` path
 * (ARCHITECTURE.md §8/§10, "never phones").
 *
 * This RPC needs `(department_id, week_start)`, which `fetchProposalSummary` above now carries
 * as `ProposalSummary.departmentId`/`.weekStart` (`answer-proposal/index.ts`'s `buildSummary()`
 * selects the proposal's own `department_id, week_start` columns). `ProposalTokenPage.tsx` passes
 * those straight into `useSadranContactQuery`, which is only enabled with a real session — for a
 * no-session token visitor the RPC's own `is_approved()`/`member_of()` gate still means the
 * button never renders, matching "hidden without a session" (UX_FLOWS.md §3.6).
 */
export async function fetchSadranContact(departmentId: string, weekStart: string) {
  return rpc("sadran_contact_of", { _department_id: departmentId, _week_start: weekStart });
}
