import { NOTIFICATION_EVENTS, type NotificationEvent } from "@/lib/enums";

/**
 * One TS mirror of `supabase/migrations/20260924110200_notification_event_meta.sql`'s seed
 * (CLAUDE.md hard rule 9 / docs/TODO.md "Code review 2026-09-24" R6). Both
 * `enqueue_notification()`/`notification_default_url()` on the SQL side and
 * `src/features/inbox/muteCategories.ts` / `src/pages/InboxPage.tsx` on this side read the
 * *same* per-event facts instead of five independently hand-maintained lists.
 *
 * `Record<NotificationEvent, ...>` means a value added to `NOTIFICATION_EVENTS` without a
 * matching row here fails `npm run typecheck` (a mapped type over a union requires every
 * key).
 *
 * Field meaning (mirrors the SQL column comments):
 * - `category` — semantic bucket. Several categories can share one inbox tab (`window` and
 *   `siddur` both render on the siddur tab, R3), but only a category's own mutable events
 *   group together for muting (R2).
 * - `memberMutable` — true iff a member can mute this event via `profiles.muted_events`
 *   (UX_FLOWS §6.1's mute-category paragraph).
 * - `sadranRole` — true iff the event bypasses a mute for a recipient currently assigned as
 *   Sadran of the event's (department, week) — `window_open` only actually bypasses for its
 *   `variant: 'sadran'` data, same nuance as the SQL side, not expressed here as a boolean.
 * - `weekScoped` — true iff, server-side, the event falls back to a `/siddur`/`/sadran` week
 *   link when no other id is present in `_data`. Not used on the TS side today (no client
 *   code recomputes `notification_default_url()`); kept for 1:1 parity with the SQL table so
 *   the two can never silently diverge.
 */
export interface NotificationEventMeta {
  category: "window" | "siddur" | "proposals" | "freedSlot" | "maintenance" | "sadran" | "account";
  memberMutable: boolean;
  sadranRole: boolean;
  weekScoped: boolean;
}

export const NOTIFICATION_EVENT_META: Record<NotificationEvent, NotificationEventMeta> = {
  window_open: { category: "window", memberMutable: true, sadranRole: true, weekScoped: true },
  window_closing: { category: "window", memberMutable: true, sadranRole: false, weekScoped: true },
  window_closed_solve_now: { category: "sadran", memberMutable: false, sadranRole: true, weekScoped: true },
  publish_reminder: { category: "sadran", memberMutable: false, sadranRole: true, weekScoped: true },
  published: { category: "siddur", memberMutable: true, sadranRole: false, weekScoped: true },
  outcome_changed: { category: "siddur", memberMutable: true, sadranRole: false, weekScoped: false },
  proposal_received: { category: "proposals", memberMutable: true, sadranRole: false, weekScoped: false },
  proposal_answered: { category: "proposals", memberMutable: false, sadranRole: true, weekScoped: false },
  freed_slot: { category: "freedSlot", memberMutable: true, sadranRole: false, weekScoped: false },
  freed_slot_auto: { category: "freedSlot", memberMutable: true, sadranRole: false, weekScoped: false },
  claim_approved: { category: "freedSlot", memberMutable: true, sadranRole: false, weekScoped: false },
  claim_declined: { category: "freedSlot", memberMutable: true, sadranRole: false, weekScoped: false },
  claim_contested: { category: "freedSlot", memberMutable: false, sadranRole: true, weekScoped: false },
  maintenance_affects: { category: "maintenance", memberMutable: true, sadranRole: false, weekScoped: false },
  late_request: { category: "sadran", memberMutable: false, sadranRole: true, weekScoped: false },
  waitlisted_request: { category: "sadran", memberMutable: false, sadranRole: true, weekScoped: false },
  auto_approved: { category: "sadran", memberMutable: false, sadranRole: true, weekScoped: false },
  request_changed: { category: "sadran", memberMutable: false, sadranRole: true, weekScoped: false },
  access_request: { category: "account", memberMutable: false, sadranRole: false, weekScoped: false },
  access_approved: { category: "account", memberMutable: false, sadranRole: false, weekScoped: false },
  status_changed: { category: "account", memberMutable: false, sadranRole: false, weekScoped: false },
  car_care: { category: "maintenance", memberMutable: true, sadranRole: false, weekScoped: false },
  waitlist_contested: { category: "freedSlot", memberMutable: true, sadranRole: false, weekScoped: false },
  waitlist_resolved: { category: "freedSlot", memberMutable: true, sadranRole: false, weekScoped: false },
  window_changed: { category: "window", memberMutable: true, sadranRole: false, weekScoped: true },
  car_swapped: { category: "siddur", memberMutable: true, sadranRole: false, weekScoped: false },
};

/** Every mutable event, grouped by `category` — the source `muteCategories.ts` builds on. */
export function mutableEventsByCategory(): Partial<Record<NotificationEventMeta["category"], NotificationEvent[]>> {
  const result: Partial<Record<NotificationEventMeta["category"], NotificationEvent[]>> = {};
  for (const event of NOTIFICATION_EVENTS) {
    const meta = NOTIFICATION_EVENT_META[event];
    if (!meta.memberMutable) continue;
    (result[meta.category] ??= []).push(event);
  }
  return result;
}

/** Inbox filter tabs (`InboxPage`). Several `category` values share a tab (R3). */
export type InboxTab = "proposals" | "siddur" | "freedSlot" | "system";

const TAB_OF_CATEGORY: Record<NotificationEventMeta["category"], InboxTab> = {
  proposals: "proposals",
  siddur: "siddur",
  window: "siddur",
  freedSlot: "freedSlot",
  maintenance: "system",
  sadran: "system",
  account: "system",
};

export function inboxTabOf(event: NotificationEvent): InboxTab {
  return TAB_OF_CATEGORY[NOTIFICATION_EVENT_META[event].category];
}
