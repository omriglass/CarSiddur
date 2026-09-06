export const memberAdminKeys = {
  all: ["admin", "members"] as const,
  profiles: () => [...memberAdminKeys.all, "profiles"] as const,
  departmentMembers: () => [...memberAdminKeys.all, "departmentMembers"] as const,
  invites: () => [...memberAdminKeys.all, "invites"] as const,
  phones: (ids: string[]) => [...memberAdminKeys.all, "phones", ids.slice().sort().join(",")] as const,
};
