// R13B10 (QA run 13): which sent proposals publishing a day expires — the browser twin of `expire_proposals()`
// (a day that becomes public settles everything face to face except a Sadran-made shift or merge, which stays open).
// The publish confirmation lists the two groups from this one rule, so it never promises to keep one that expires.
export function expiresAtPublish(proposal: { type: string; created_via: string | null }): boolean {
  return !((proposal.type === "shift" || proposal.type === "merge") && proposal.created_via === "sadran");
}
