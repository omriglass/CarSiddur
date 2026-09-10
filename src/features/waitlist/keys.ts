// Query keys for the `waitlist` feature (CLAUDE.md "Structure": query keys live in `keys.ts`).
export const waitlistKeys = {
  all: ["waitlist"] as const,
  groups: (departmentId: string, weekStart: string) => [...waitlistKeys.all, departmentId, weekStart] as const,
};
