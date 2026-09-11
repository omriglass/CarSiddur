import { he } from "@/i18n/he";
import type { NotificationEvent } from "@/lib/enums";

export interface MuteCategory {
  key: string;
  label: string;
  events: readonly NotificationEvent[];
}

/**
 * Mute categories → `notification_event` values (UX_FLOWS.md §3.8 item 3).
 * Sadran/Admin-only events and `auto_approved`/`access_approved`/`status_changed` are not
 * mutable at all and so have no category here (enforced server-side too,
 * in `enqueue_notification()`, DATA_MODEL §3.11).
 */
export const MUTE_CATEGORIES: readonly MuteCategory[] = [
  { key: "window", label: he.profileExtra.muteWindow, events: ["window_open", "window_closing"] },
  { key: "siddur", label: he.profileExtra.muteSiddur, events: ["published", "outcome_changed"] },
  { key: "proposals", label: he.profileExtra.muteProposals, events: ["proposal_received"] },
  {
    key: "freedSlots",
    label: he.profileExtra.muteFreedSlots,
    events: ["freed_slot", "freed_slot_auto", "claim_approved", "claim_declined"],
  },
  { key: "maintenance", label: he.profileExtra.muteMaintenance, events: ["maintenance_affects", "car_care"] },
];
