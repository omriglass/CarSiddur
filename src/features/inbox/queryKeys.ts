export const inboxKeys = {
  mine: (profileId: string | undefined) => ["inbox", "mine", profileId] as const,
  unreadCount: (profileId: string | undefined) => ["inbox", "unreadCount", profileId] as const,
};
