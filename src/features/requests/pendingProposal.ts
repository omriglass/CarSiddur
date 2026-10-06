// G5 (docs/TODO.md): only a proposal still awaiting the member's answer may surface as
// "מחכה לתשובה שלך" — sent and not past its expiry. Accepted/declined/withdrawn/applied/expired/
// superseded never do.
interface ProposalLike {
  status: string;
  expires_at: string | null;
}

export function isAwaitingAnswer(proposal: { status?: string; expiresAt?: string | null; expires_at?: string | null }, now: number = Date.now()): boolean {
  // A mapped `MyRequestPendingProposal` carries no status — `pickPendingProposal` already kept only `sent`.
  if (proposal.status !== undefined && proposal.status !== "sent") return false;
  const expires = proposal.expiresAt ?? proposal.expires_at ?? null;
  return expires === null || Date.parse(expires) > now;
}

export function pickPendingProposal<T extends ProposalLike>(proposals: readonly T[], now: number = Date.now()): T | null {
  return proposals.find((p) => isAwaitingAnswer(p, now)) ?? null;
}

interface ProposalWithParties extends ProposalLike {
  parties?: readonly { profile_id: string; response: string }[] | null;
}

/**
 * R5B9: what the member still has to answer vs what they answered while the proposal waits for the
 * other parties (a merge needs the host / other passengers too). `pending` is the first sent proposal
 * the member has NOT answered; `answeredWaiting` is true when a sent proposal carries their accept/decline.
 */
export function splitMemberProposals<T extends ProposalWithParties>(proposals: readonly T[], profileId: string | undefined, now: number = Date.now()): { pending: T | null; answeredWaiting: boolean } {
  const own = (p: T) => (profileId ? p.parties?.find((party) => party.profile_id === profileId)?.response : undefined);
  const pending = pickPendingProposal(proposals.filter((p) => own(p) === undefined || own(p) === "pending"), now);
  const answeredWaiting = proposals.some((p) => p.status === "sent" && (own(p) === "accepted" || own(p) === "declined"));
  return { pending, answeredWaiting };
}
