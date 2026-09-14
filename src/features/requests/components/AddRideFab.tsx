import { NewRequestButton } from "@/features/requests/components/NewRequestButton";

/**
 * Shared floating "+ בקשה חדשה" button (UX_FLOWS.md §2, "A floating '+' sits above the bar on
 * הסידור and הבקשות שלי") — used by both `SiddurPage` and `HomePage` so they can never drift
 * in icon/label/position again.
 *
 * As of F2 (docs/TODO.md 2026-09-14) the label/target/enabled-ness is the shared three/four-state
 * button (`NewRequestButton`, `newRequestButton.ts`) instead of an always-on "בקשה חדשה" linking
 * unconditionally to `/requests/new` — see there for the state machine. "I want a car now" is
 * the separate, unaffected `CarNowButton` (owner A3).
 */
export function AddRideFab() {
  return <NewRequestButton variant="fab" />;
}
