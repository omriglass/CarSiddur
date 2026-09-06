export const requestsKeys = {
  mine: (profileId: string | undefined) => ["requests", "mine", profileId] as const,
  byId: (requestId: string | undefined) => ["requests", "byId", requestId] as const,
  companions: (requestId: string | undefined) => ["requests", "companions", requestId] as const,
  freedOffers: (profileId: string | undefined) => ["requests", "freedOffers", profileId] as const,
};
