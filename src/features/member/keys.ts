export const memberKeys = {
  all: ["member"] as const,
  guardedChildren: (profileId: string | undefined) => ["member", "guardedChildren", profileId] as const,
};
