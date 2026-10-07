// Query keys for the whole `sadran` feature (dashboard, board, proposals,
// claims, publish, change log) — one factory, since every screen shares the
// same `(departmentId, weekStart)` scope (ui-dev.md "Structure": query keys
// live in `keys.ts`).
export const sadranKeys = {
  all: ["sadran"] as const,
  week: (departmentId: string, weekStart: string) => [...sadranKeys.all, departmentId, weekStart] as const,
  weekRow: (departmentId: string, weekStart: string) => [...sadranKeys.week(departmentId, weekStart), "weekRow"] as const,
  boardRides: (departmentId: string, weekStart: string) =>
    [...sadranKeys.week(departmentId, weekStart), "boardRides"] as const,
  carLocations: (departmentId: string, weekStart: string) =>
    [...sadranKeys.week(departmentId, weekStart), "carLocations"] as const,
  weekRequestsWithNames: (departmentId: string, weekStart: string) =>
    [...sadranKeys.week(departmentId, weekStart), "requestsWithNames"] as const,
  cars: (departmentId: string) => [...sadranKeys.all, departmentId, "cars"] as const,
  seatConfigs: (departmentId: string) => [...sadranKeys.all, departmentId, "seatConfigs"] as const,
  destinations: () => [...sadranKeys.all, "destinations"] as const,
  fairnessStats: (departmentId: string, weekStart: string, lookbackWeeks: number) =>
    [...sadranKeys.week(departmentId, weekStart), "fairnessStats", lookbackWeeks] as const,
  /** F5 (docs/SOLVER.md §3.6.2): `car_mileage_totals()`, rolling window fixed at 4 weeks. */
  mileageTotals: (departmentId: string, weekStart: string) =>
    [...sadranKeys.week(departmentId, weekStart), "mileageTotals"] as const,
  /** REQUIREMENTS §13.93 (ORIGINS_PLAN §2 item 7): `car_start_locations()`. */
  carStartLocations: (departmentId: string, weekStart: string) =>
    [...sadranKeys.week(departmentId, weekStart), "carStartLocations"] as const,
  /** R5B5: the server's `merge_preview` for one ride/request/leg. */
  /** Root of every `merge_preview` query - `invalidateWeekData` refreshes them all (a ride/request change can change any verdict). */
  mergePreviews: () => [...sadranKeys.all, "mergePreview"] as const,
  mergePreview: (rideId: string, requestId: string, leg: string) => [...sadranKeys.all, "mergePreview", rideId, requestId, leg] as const,
  /** REQUIREMENTS §13.93 (ORIGINS_PLAN §2 item 6): `place_travel_for_week()`. */
  placeTravel: (departmentId: string, weekStart: string) =>
    [...sadranKeys.week(departmentId, weekStart), "placeTravel"] as const,
  /** REQ §13.101 (j): the legs of one multi-day request. */
  seriesLegs: (seriesId: string) => [...sadranKeys.all, "seriesLegs", seriesId] as const,
  rideTypes: () => [...sadranKeys.all, "rideTypes"] as const,
  departmentSettings: (departmentId: string) => [...sadranKeys.all, departmentId, "settings"] as const,
  activePolicy: (departmentId: string) => [...sadranKeys.all, departmentId, "activePolicy"] as const,
  maintenanceBlocks: (departmentId: string) => [...sadranKeys.all, departmentId, "maintenanceBlocks"] as const,
  solverRuns: (departmentId: string, weekStart: string) =>
    [...sadranKeys.week(departmentId, weekStart), "solverRuns"] as const,
  proposals: (departmentId: string, weekStart: string) =>
    [...sadranKeys.week(departmentId, weekStart), "proposals"] as const,
  proposalParties: (proposalId: string) => [...sadranKeys.all, "proposalParties", proposalId] as const,
  freedOffers: (departmentId: string, weekStart: string) =>
    [...sadranKeys.week(departmentId, weekStart), "freedOffers"] as const,
  freedClaims: (offerId: string) => [...sadranKeys.all, "freedClaims", offerId] as const,
  siddurVersions: (departmentId: string, weekStart: string) =>
    [...sadranKeys.week(departmentId, weekStart), "siddurVersions"] as const,
  auditLog: (departmentId: string, weekStart: string) =>
    [...sadranKeys.week(departmentId, weekStart), "auditLog"] as const,
  departmentMembers: (departmentId: string) => [...sadranKeys.all, departmentId, "members"] as const,
  whatsappTemplates: () => [...sadranKeys.all, "whatsappTemplates"] as const,
  mySadranDepartments: (profileId: string | undefined) => [...sadranKeys.all, "mine", profileId] as const,
  policyOptions: (departmentId: string) => [...sadranKeys.activePolicy(departmentId), "options"] as const,
  profilesByIds: (sortedJoinedIds: string) => [...sadranKeys.all, "profiles", sortedJoinedIds] as const,
  publicationReadiness: (departmentId: string, weekStart: string) =>
    [...sadranKeys.week(departmentId, weekStart), "publicationReadiness"] as const,
  switchableWeeks: (departmentId: string, profileId: string | undefined, weekStarts: readonly string[]) =>
    [...sadranKeys.all, departmentId, "switchableWeeks", profileId, ...weekStarts] as const,
  reopenFingerprint: (departmentId: string, weekStart: string) =>
    [...sadranKeys.week(departmentId, weekStart), "reopenFingerprint"] as const,
  excelExport: (departmentId: string, weekStart: string) =>
    [...sadranKeys.week(departmentId, weekStart), "excelExport"] as const,
  proposalHostRide: (rideId: string | null | undefined) => [...sadranKeys.all, "proposalHostRide", rideId] as const,
};
