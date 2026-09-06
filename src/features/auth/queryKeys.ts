/** TanStack Query keys for the auth feature (CLAUDE.md Conventions: keys in `keys.ts`). */
export const authKeys = {
  profile: (profileId: string | undefined) => ["auth", "profile", profileId] as const,
  myDepartments: (profileId: string | undefined) => ["auth", "departments", profileId] as const,
  isSadran: (profileId: string | undefined, departmentId: string, weekStart: string) =>
    ["auth", "isSadran", profileId, departmentId, weekStart] as const,
  isSadranAnywhere: (profileId: string | undefined, departmentIds: readonly string[]) =>
    ["auth", "isSadranAnywhere", profileId, ...departmentIds] as const,
  departmentMembers: (departmentId: string | undefined) =>
    ["auth", "departmentMembers", departmentId] as const,
  pushSubscriptionCount: (profileId: string | undefined) =>
    ["auth", "pushSubscriptionCount", profileId] as const,
};
