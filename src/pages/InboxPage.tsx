import { Bell } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { paths } from "@/app/routes";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Notification } from "@/features/inbox/api";
import {
  useMarkAllNotificationsReadMutation,
  useMarkNotificationReadMutation,
  useNotifications,
} from "@/features/inbox/hooks";
import { he, t } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import type { NotificationEvent } from "@/lib/enums";
import { inboxTabOf } from "@/lib/notificationEvents";
import { formatTime } from "@/lib/time";
import { RideChangeAnswers } from "@/features/siddur/components/RideChangeAnswers";

type Filter = "all" | "proposals" | "siddur" | "freedSlot" | "system";

/**
 * Tab assignment is derived from `NOTIFICATION_EVENT_META` (`src/lib/notificationEvents.ts`,
 * docs/TODO.md R6/R3) instead of four hand-maintained event-name sets, so a new event or a
 * category fix (e.g. `window_changed`/`waitlist_*`/`car_swapped`) only needs updating there.
 */
function matchesFilter(event: string, filter: Filter): boolean {
  if (filter === "all") return true;
  return inboxTabOf(event as NotificationEvent) === filter;
}

const SADRAN_EVENTS = new Set([
  "window_closed_solve_now",
  "publish_reminder",
  "proposal_answered",
  "claim_contested",
  "late_request",
  "waitlisted_request",
  "request_changed",
]);

/**
 * Deep-links a notification's `data` payload to a screen (UX_FLOWS.md §3.7).
 * Prefers an explicit `data.url` (the DB is starting to populate this on
 * more event rows) or a bare `data.token` (`/p/<token>`, the deep-link
 * secret itself); falls back to id-based routing for older/other rows.
 * `request_id` lands on `/my?focus=<id>` (`HomePage` scrolls to and ring-highlights that
 * card); `offer_id` has no matching card on `/my` today, so it lands on the plain list.
 */
function deepLinkFor(n: Notification): string {
  const data = (n.data as Record<string, unknown>) ?? {};
  if (typeof data.url === "string" && data.url) return data.url;
  if (typeof data.token === "string" && data.token) return paths.proposalToken(data.token);
  if (typeof data.ride_change_id === "string") return paths.inbox(data.ride_change_id);
  if (typeof data.proposal_id === "string" && n.department_id && n.week_start) {
    return paths.sadran.proposals(n.department_id, n.week_start, data.proposal_id);
  }
  if (typeof data.request_id === "string") return paths.my(data.request_id);
  if (typeof data.offer_id === "string") return paths.my();
  if (typeof data.ride_id === "string") return paths.siddur();
  // `car_care` (REQUIREMENTS §6.6, UX_FLOWS §6.1): `notification_default_url()`'s `car_id` branch.
  if (typeof data.car_id === "string") return paths.car(data.car_id);
  return paths.inbox();
}

function dayLabel(instant: string): string {
  return formatDayDate(instant);
}

/** `/inbox` (UX_FLOWS.md §3.7): grouped by day, read state, category filter, mark-all-read. */
export function InboxPage() {
  const navigate = useNavigate();
  const notificationsQuery = useNotifications();
  const markReadMutation = useMarkNotificationReadMutation();
  const markAllReadMutation = useMarkAllNotificationsReadMutation();
  const [filter, setFilter] = useState<Filter>("all");

  const rows = notificationsQuery.data ?? [];
  const filtered = rows.filter((n) => matchesFilter(n.event, filter));

  const groups = useMemo(() => {
    const byDay = new Map<string, Notification[]>();
    for (const n of filtered) {
      const key = dayLabel(n.created_at);
      const list = byDay.get(key) ?? [];
      list.push(n);
      byDay.set(key, list);
    }
    return [...byDay.entries()];
  }, [filtered]);

  function open(n: Notification) {
    if (!n.read_at) markReadMutation.mutate(n.id);
    navigate(deepLinkFor(n));
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 pb-24">
      <PageHeader
        title={t("screen.inbox.title")}
        actions={
          rows.some((n) => !n.read_at) ? (
            <Button size="sm" variant="outline" onClick={() => markAllReadMutation.mutate()}>
              {t("action.markAllRead")}
            </Button>
          ) : undefined
        }
      />

      <RideChangeAnswers />

      <ToggleGroup
        type="single"
        value={filter}
        onValueChange={(next) => next && setFilter(next as Filter)}
        className="flex-wrap justify-start"
      >
        <ToggleGroupItem value="all" className="h-9 px-3 text-xs">
          {he.inboxExtra.filterAll}
        </ToggleGroupItem>
        <ToggleGroupItem value="proposals" className="h-9 px-3 text-xs">
          {he.inboxExtra.filterProposals}
        </ToggleGroupItem>
        <ToggleGroupItem value="siddur" className="h-9 px-3 text-xs">
          {he.inboxExtra.filterSiddur}
        </ToggleGroupItem>
        <ToggleGroupItem value="freedSlot" className="h-9 px-3 text-xs">
          {he.inboxExtra.filterFreedSlot}
        </ToggleGroupItem>
        <ToggleGroupItem value="system" className="h-9 px-3 text-xs">
          {he.inboxExtra.filterSystem}
        </ToggleGroupItem>
      </ToggleGroup>

      {groups.length === 0 ? (
        <EmptyState icon={Bell} message={he.inboxExtra.empty} />
      ) : (
        groups.map(([day, items]) => (
          <section key={day} className="space-y-2">
            <h2 className="text-xs font-semibold text-muted-foreground" dir="ltr">
              {day}
            </h2>
            <div className="space-y-1">
              {items.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => open(n)}
                  className="flex w-full items-start gap-2 rounded-md border p-3 text-start text-sm hover:bg-accent/40"
                >
                  {!n.read_at ? (
                    <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                  ) : (
                    <span className="mt-1.5 size-2 shrink-0" aria-hidden="true" />
                  )}
                  <span className="flex-1 space-y-0.5">
                    <span className="flex items-center gap-2 font-medium">
                      {n.title_he}
                      {SADRAN_EVENTS.has(n.event) ? (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {he.inboxExtra.sadranChip}
                        </span>
                      ) : null}
                    </span>
                    <span className="block text-muted-foreground">{n.body_he}</span>
                    <span className="block text-xs text-muted-foreground" dir="ltr">
                      {formatTime(new Date(n.created_at))}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
