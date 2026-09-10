export const siddurKeys = {
  /** Root key — invalidate every `siddur`-feature query at once (REFACTOR_BACKLOG.md 1.4). */
  all: ["siddur"] as const,
  departments: () => ["siddur", "departments"] as const,
  currentWeekStart: () => ["siddur", "currentWeekStart"] as const,
  weeks: (departmentId: string | undefined) => ["siddur", "weeks", departmentId] as const,
  boardRides: (departmentId: string, weekStart: string) =>
    ["siddur", "boardRides", departmentId, weekStart] as const,
  boardRideById: (rideId: string | undefined) => ["siddur", "boardRideById", rideId] as const,
  carForRide: (carId: string | undefined) => ["siddur", "carForRide", carId] as const,
  carLocations: (departmentId: string | undefined, weekStart: string | undefined) =>
    ["siddur", "carLocations", departmentId, weekStart] as const,
  myUpcomingRides: (profileId: string | undefined, departmentId: string | undefined) =>
    ["siddur", "myUpcomingRides", profileId, departmentId] as const,
  rideChanges: (userId: string | undefined, departmentId: string | undefined, weekStart: string | undefined) =>
    ["siddur", "rideChanges", userId, departmentId, weekStart] as const,
  weekExport: (departmentId: string, weekStart: string) =>
    ["siddur", "weekExport", departmentId, weekStart] as const,
};
