export const destinationAdminKeys = {
  all: ["admin", "destinations"] as const,
  list: () => [...destinationAdminKeys.all, "list"] as const,
  freeTextQueue: () => [...destinationAdminKeys.all, "freeTextQueue"] as const,
};
