// R8U2: what a click on a `merge:<proposalId>` ghost opens. A merge waiting for the guest's answer (sent/accepted) must not
// hide the host ride, so the ride sheet opens (driver, times, route stay editable, with a link to the proposal); a draft
// keeps opening its own action sheet (send/discard).
export type MergeGhostTarget = { kind: "ride"; rideId: string } | { kind: "proposal"; proposalId: string };

export function mergeGhostTarget(proposals: readonly { id: string; status: string; ride_id: string | null }[], ghostId: string): MergeGhostTarget {
  const proposalId = ghostId.slice("merge:".length);
  const pending = proposals.find((proposal) => proposal.id === proposalId);
  if (pending && pending.status !== "draft" && pending.ride_id) return { kind: "ride", rideId: pending.ride_id };
  return { kind: "proposal", proposalId };
}
