// R20M1 (owner 2026-11-14, REQ item 233): "מאז שהסתכלת לאחרונה" — a quiet, collapsed strip on the board of what others
// did on published days. The badge counts what is new; opening the strip counts as looked. No push, no inbox notice.
import { ChevronDown } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { he, tv } from "@/i18n/he";
import { cn } from "@/lib/utils";

import type { BoardLiveEvent } from "../../api";
import { useBoardLiveEventsQuery, useMarkBoardSeenMutation } from "../../hooks";
import { liveEventText, liveEventWhen, newEventCount } from "../liveEvents";

interface LiveEventsStripProps {
  departmentId: string;
  weekStart: string;
  /** The week has published days. */
  enabled: boolean;
  onOpenEvent: (event: BoardLiveEvent) => void;
}

export function LiveEventsStrip({ departmentId, weekStart, enabled, onOpenEvent }: LiveEventsStripProps) {
  const query = useBoardLiveEventsQuery(departmentId, weekStart, enabled);
  const mark = useMarkBoardSeenMutation();
  const [open, setOpen] = useState(false);
  // The marker this visit began with: lines after it stay highlighted after the strip is opened.
  const [baseline, setBaseline] = useState<number | null>(null);
  const data = query.data;
  // Set once, while rendering the first answer (the parent keys this strip by week, so a new week starts over).
  if (data && baseline === null) setBaseline(data.seenAuditId);

  const events = data?.events ?? [];
  if (!enabled || events.length === 0) return null;
  const count = newEventCount(events, data?.seenAuditId ?? 0);
  const highlightAfter = baseline ?? data?.seenAuditId ?? 0;

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && count > 0) mark.mutate({ departmentId, weekStart });
  }

  return (
    <section className="rounded-md border bg-card text-sm" data-testid="board-live-events">
      <button type="button" onClick={toggle} aria-expanded={open}
        aria-label={count > 0 ? tv("liveEvents.titleCount", { count: String(count) }) : he.liveEvents.title}
        className="flex w-full items-center gap-2 px-3 py-2 text-start font-medium">
        <span>{he.liveEvents.title}</span>
        {count > 0 ? <Badge className="px-1.5" data-testid="board-live-events-badge"><span dir="ltr">{count}</span></Badge> : null}
        <ChevronDown className={cn("ms-auto size-4 transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open ? (
        <ul className="divide-y border-t">
          {events.map((event) => {
            const isNew = event.id > highlightAfter;
            const when = liveEventWhen(event);
            return (
              <li key={event.id}>
                <button type="button" disabled={!event.ride_id && !event.starts_at} onClick={() => onOpenEvent(event)}
                  className={cn("w-full px-3 py-1.5 text-start", isNew ? "font-semibold" : "text-muted-foreground")}
                  data-testid="board-live-event" data-kind={event.kind} data-new={isNew ? "true" : undefined}>
                  {isNew ? <span className="me-1.5 inline-block size-2 rounded-full bg-primary align-middle" aria-hidden="true" /> : null}
                  {liveEventText(event)}
                  {when ? <span className="text-muted-foreground"> · {when}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

