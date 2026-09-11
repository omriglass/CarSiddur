export const inboxKeys = {
  /** Root key — invalidate every `inbox`-feature query at once (REFACTOR_BACKLOG.md 1.4). */
  all: ["inbox"] as const,
  mine: (profileId: string | undefined) => ["inbox", "mine", profileId] as const,
  unreadCount: (profileId: string | undefined) => ["inbox", "unreadCount", profileId] as const,
  /** `useProposalLinkMutation`'s `mutationKey` — resolving a `/p/:token` link is a one-off lookup, not cached. */
  proposalLink: () => ["inbox", "proposalLink"] as const,
};
