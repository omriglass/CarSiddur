import { he } from "@/i18n/he";
import type { NotificationEvent } from "@/lib/enums";
import { mutableEventsByCategory } from "@/lib/notificationEvents";

export interface MuteCategory {
  key: string;
  label: string;
  events: readonly NotificationEvent[];
}

/**
 * Mute categories → `notification_event` values (UX_FLOWS.md §3.8 item 3).
 * Derived from `NOTIFICATION_EVENT_META` (`src/lib/notificationEvents.ts`, docs/TODO.md R6) —
 * the one place event→category/mutability now lives, mirroring
 * `notification_event_meta` (SQL). Sadran/Admin-only events and
 * `auto_approved`/`access_approved`/`status_changed` are `memberMutable: false` there and so
 * have no category here (enforced server-side too, in `enqueue_notification()`,
 * DATA_MODEL §3.11).
 */
const BY_CATEGORY = mutableEventsByCategory();

export const MUTE_CATEGORIES: readonly MuteCategory[] = [
  { key: "window", label: he.profileExtra.muteWindow, events: BY_CATEGORY.window ?? [] },
  { key: "siddur", label: he.profileExtra.muteSiddur, events: BY_CATEGORY.siddur ?? [] },
  { key: "proposals", label: he.profileExtra.muteProposals, events: BY_CATEGORY.proposals ?? [] },
  { key: "freedSlots", label: he.profileExtra.muteFreedSlots, events: BY_CATEGORY.freedSlot ?? [] },
  { key: "maintenance", label: he.profileExtra.muteMaintenance, events: BY_CATEGORY.maintenance ?? [] },
];
