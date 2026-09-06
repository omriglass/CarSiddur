export const proposalsKeys = {
  byToken: (token: string | undefined) => ["proposals", "byToken", token] as const,
};
