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
  /** What I may manage in a department (`my_department_access`): every permission hook reads this one entry. */
  departmentAccess: (profileId: string | undefined, departmentId: string | undefined) =>
    ["auth", "access", profileId, departmentId] as const,
  departmentMembers: (departmentId: string | undefined, includeSelf = false) =>
    ["auth", "departmentMembers", departmentId, ...(includeSelf ? ["withSelf"] : [])] as const,
  pushSubscriptionCount: (profileId: string | undefined) =>
    ["auth", "pushSubscriptionCount", profileId] as const,
};
