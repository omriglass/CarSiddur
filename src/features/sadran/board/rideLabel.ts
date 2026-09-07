// src/features/sadran/board/rideLabel.ts
//
// Re-exports the shared ride-label helper (moved to `src/lib/rideLabel.ts`
// once the same "shows the department's own name instead of the real
// destination" bug was found on the member siddur/Home, not just the Sadran
// board — UX_FLOWS.md §20) so existing imports from this path keep working.
export {
  rideBlockLabel,
  resolveRideRealDestination,
  type RideLabelInput,
  type RideLabelServedEntry,
} from "@/lib/rideLabel";
