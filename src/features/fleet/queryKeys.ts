export const fleetKeys = {
  cars: (departmentId: string | undefined) => ["fleet", "cars", departmentId] as const,
  destinations: () => ["fleet", "destinations"] as const,
  rideTypes: () => ["fleet", "rideTypes"] as const,
  seatConfigs: (departmentId: string | undefined) => ["fleet", "seatConfigs", departmentId] as const,
  myTemporaryCars: (ownerId: string | undefined) => ["fleet", "myTemporaryCars", ownerId] as const,
  turnaroundMinutes: (departmentId: string | undefined) => ["fleet", "turnaroundMinutes", departmentId] as const,
  maintenanceBlocks: (departmentId: string | undefined) => ["fleet", "maintenanceBlocks", departmentId] as const,
};
