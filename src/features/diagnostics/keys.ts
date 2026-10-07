// Query keys for the `diagnostics` feature (CLAUDE.md "Structure": query keys live in `keys.ts`).
export const diagnosticsKeys = {
  all: ["diagnostics"] as const,
  clientErrors: () => [...diagnosticsKeys.all, "clientErrors"] as const,
};
