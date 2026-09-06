export const carAdminKeys = {
  all: ["admin", "cars"] as const,
  list: () => [...carAdminKeys.all, "list"] as const,
  seatConfigs: (carId: string | undefined) => [...carAdminKeys.all, "seatConfigs", carId] as const,
  maintenance: () => [...carAdminKeys.all, "maintenance"] as const,
  issues: () => [...carAdminKeys.all, "issues"] as const,
};
