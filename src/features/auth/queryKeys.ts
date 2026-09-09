/**
 * `useActiveDepartment`'s "all departments regardless of membership" query
 * (`src/features/auth/useActiveDepartment.ts`) doesn't fit `authKeys` (it's
 * not scoped to a profile's own auth state) or `siddurKeys` (a different
 * feature's cache), so it gets its own tiny factory here instead of the
 * literal `["context"]`/`["context", "departments", profileId]` that used to
 * be hand-written both at the query site and every invalidating mutation
 * (REFACTOR_BACKLOG.md 1.4).
 */
export const contextKeys = {
  all: ["context"] as const,
  departments: (profileId: string | undefined) => [...contextKeys.all, "departments", profileId] as const,
};

/** TanStack Query keys for the auth feature (CLAUDE.md Conventions: keys in `keys.ts`). */
export const authKeys = {
  all: ["auth"] as const,
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
