export const departmentAdminKeys = {
  all: ["admin", "departments"] as const,
  list: () => [...departmentAdminKeys.all, "list"] as const,
  counts: () => [...departmentAdminKeys.all, "counts"] as const,
  settings: (departmentId: string | undefined) => [...departmentAdminKeys.all, "settings", departmentId] as const,
};
