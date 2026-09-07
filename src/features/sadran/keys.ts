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
  weekRequests: (departmentId: string, weekStart: string) =>
    [...sadranKeys.week(departmentId, weekStart), "requests"] as const,
  weekRequestsWithNames: (departmentId: string, weekStart: string) =>
    [...sadranKeys.week(departmentId, weekStart), "requestsWithNames"] as const,
  cars: (departmentId: string) => [...sadranKeys.all, departmentId, "cars"] as const,
  seatConfigs: (departmentId: string) => [...sadranKeys.all, departmentId, "seatConfigs"] as const,
  destinations: () => [...sadranKeys.all, "destinations"] as const,
  rideTypes: () => [...sadranKeys.all, "rideTypes"] as const,
  departmentSettings: (departmentId: string) => [...sadranKeys.all, departmentId, "settings"] as const,
  activePolicy: (departmentId: string) => [...sadranKeys.all, departmentId, "activePolicy"] as const,
  fairness: (departmentId: string, weekStart: string, lookbackWeeks: number) =>
    [...sadranKeys.week(departmentId, weekStart), "fairness", lookbackWeeks] as const,
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
};
