export const siddurKeys = {
  departments: () => ["siddur", "departments"] as const,
  currentWeekStart: () => ["siddur", "currentWeekStart"] as const,
  weeks: (departmentId: string | undefined) => ["siddur", "weeks", departmentId] as const,
  openLiveWeekStarts: (departmentId: string) => ["siddur", "openLiveWeekStarts", departmentId] as const,
  boardRides: (departmentId: string, weekStart: string) =>
    ["siddur", "boardRides", departmentId, weekStart] as const,
  boardRideById: (rideId: string | undefined) => ["siddur", "boardRideById", rideId] as const,
  carForRide: (carId: string | undefined) => ["siddur", "carForRide", carId] as const,
  carLocations: (departmentId: string | undefined, weekStart: string | undefined) =>
    ["siddur", "carLocations", departmentId, weekStart] as const,
  boardStartTime: (departmentId: string | undefined) => ["siddur", "boardStartTime", departmentId] as const,
};
