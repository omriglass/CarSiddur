export const rosterAdminKeys = {
  all: ["admin", "roster"] as const,
  assignments: (weekStarts: string[]) => [...rosterAdminKeys.all, weekStarts.slice().sort().join(",")] as const,
};
