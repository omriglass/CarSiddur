export const requestsKeys = {
  /** Root key — invalidate every `requests`-feature query at once (REFACTOR_BACKLOG.md 1.4). */
  all: ["requests"] as const,
  mine: (profileId: string | undefined) => ["requests", "mine", profileId] as const,
  byId: (requestId: string | undefined) => ["requests", "byId", requestId] as const,
  companions: (requestId: string | undefined) => ["requests", "companions", requestId] as const,
  freedOffers: (profileId: string | undefined) => ["requests", "freedOffers", profileId] as const,
};
