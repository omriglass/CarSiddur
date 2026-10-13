// Query keys for the `policyView` feature (CLAUDE.md "Structure": query keys live in `keys.ts`).
export const policyViewKeys = {
  all: ["policyView"] as const,
  policies: (departmentId: string) => [...policyViewKeys.all, "policies", departmentId] as const,
  alignment: (policyId: string) => [...policyViewKeys.all, "alignment", policyId] as const,
};
