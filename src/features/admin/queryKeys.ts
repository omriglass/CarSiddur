/** TanStack Query keys for `src/features/admin/useOperations.ts` (root-level admin queries, not scoped under a subfolder). */
export const operationsKeys = {
  all: ["operations"] as const,
  access: (profileId: string | undefined, departmentId: string | undefined) =>
    [...operationsKeys.all, "access", profileId, departmentId] as const,
  departments: (profileId: string | undefined, departmentId: string | undefined) =>
    [...operationsKeys.all, "departments", profileId, departmentId] as const,
};
