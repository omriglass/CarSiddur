export const inboxKeys = {
  mine: (profileId: string | undefined) => ["inbox", "mine", profileId] as const,
  unreadCount: (profileId: string | undefined) => ["inbox", "unreadCount", profileId] as const,
  /** `useProposalLinkMutation`'s `mutationKey` — resolving a `/p/:token` link is a one-off lookup, not cached. */
  proposalLink: () => ["inbox", "proposalLink"] as const,
};
