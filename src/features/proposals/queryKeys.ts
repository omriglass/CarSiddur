export const proposalsKeys = {
  byToken: (token: string | undefined) => ["proposals", "byToken", token] as const,
  sadranContact: (departmentId: string | undefined, weekStart: string | undefined) =>
    ["proposals", "sadranContact", departmentId, weekStart] as const,
};
