// Query keys for the `stats` feature (CLAUDE.md "Structure": query keys live in `keys.ts`).
export const statsKeys = {
  all: ["stats"] as const,
  department: (departmentId: string, from: string, to: string) =>
    [...statsKeys.all, departmentId, from, to] as const,
};
