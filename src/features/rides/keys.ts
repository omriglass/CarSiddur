import { siddurKeys } from "@/features/siddur/queryKeys";

/** Query keys for the `rides` feature (CLAUDE.md "Structure") — shared ride-level pieces moved out of `siddur`/`sadran` (R8). */
export const ridesKeys = {
  all: ["rides"] as const,
  /**
   * Deliberately still under the `siddur` root (its pre-R8 key): every mutation that refreshes
   * `siddurKeys.all` or `invalidateWeekData()` must also refresh pending ride changes — the
   * member's "change:" blocks on the siddur grid disappear otherwise (e2e/ride-editing.spec.ts).
   */
  rideChanges: (userId: string | undefined, departmentId: string | undefined, weekStart: string | undefined, fromWeek?: string) =>
    [siddurKeys.all[0], "rideChanges", userId, departmentId, weekStart, fromWeek] as const,
  /**
   * Under the `siddur` root like `rideChanges`: every ride/request change already refreshes the siddur
   * family, which keeps the "be back on time" neighbours (REQ §13.108 f) fresh with no extra wiring.
   */
  carNeighbours: (rideIds: readonly string[]) => [siddurKeys.all[0], "carNeighbours", [...rideIds].sort().join(",")] as const,
  /** REQ item 246 h: one ride's stops view (`ride_stretches`), read when its sheet opens; the ride's version keeps it fresh. */
  stretches: (rideId: string, version: number | null | undefined) => [siddurKeys.all[0], "rideStretches", rideId, version ?? null] as const,
  /** RP1: the cards' complex rides in one read (`rides_stretches`), keyed by each ride's id and version. */
  stretchesBatch: (rides: readonly string[]) => [siddurKeys.all[0], "rideStretchesBatch", [...rides].sort().join(",")] as const,
};
