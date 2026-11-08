export const memberKeys = {
  all: ["member"] as const,
  guardedChildren: (profileId: string | undefined) => ["member", "guardedChildren", profileId] as const,
  rideEditors: (profileId: string | undefined) => ["member", "rideEditors", profileId] as const,
};
