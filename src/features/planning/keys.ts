// Query keys for the `planning` feature (CLAUDE.md "Structure": query keys live in `keys.ts`).
export const planningKeys = {
  all: ["planning"] as const,
  month: (departmentId: string, from: string, to: string) => [...planningKeys.all, "month", departmentId, from, to] as const,
  typicalUsage: (departmentId: string) => [...planningKeys.all, "typicalUsage", departmentId] as const,
  settings: (departmentId: string) => [...planningKeys.all, "settings", departmentId] as const,
  ownReservation: (reservationId: string) => [...planningKeys.all, "own", reservationId] as const,
};
