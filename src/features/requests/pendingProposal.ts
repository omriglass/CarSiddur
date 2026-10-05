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
