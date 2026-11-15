// R20M1 (owner 2026-11-14, REQ item 233): "מאז שהסתכלת לאחרונה" — a quiet, collapsed strip on the board of what others
// did on published days. Read only when the strip is opened (owner 2026-11-15: the read is heavy and was part of every
// board load), so the closed strip shows no count; opening it counts as looked. No push, no inbox notice.
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { he } from "@/i18n/he";
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
  const [open, setOpen] = useState(false);
  const query = useBoardLiveEventsQuery(departmentId, weekStart, enabled && open);
  const mark = useMarkBoardSeenMutation();
  const markMutate = mark.mutate;
  // The marker this visit began with: lines after it stay highlighted after the strip is opened.
  const [baseline, setBaseline] = useState<number | null>(null);
  const data = query.data;
  // Set once, while rendering the first answer (the parent keys this strip by week, so a new week starts over).
  if (data && baseline === null) setBaseline(data.seenAuditId);

  const events = data?.events ?? [];
  const count = data ? newEventCount(events, data.seenAuditId) : 0;
  const highlightAfter = baseline ?? data?.seenAuditId ?? 0;
  // Opening counts as looked: once per opening, when the answer holds something new.
  const markedRef = useRef(false);
  useEffect(() => {
    if (!open) { markedRef.current = false; return; }
    if (count > 0 && !markedRef.current) {
      markedRef.current = true;
      markMutate({ departmentId, weekStart });
    }
  }, [open, count, departmentId, weekStart, markMutate]);

  if (!enabled) return null;

  return (
    <section className="rounded-md border bg-card text-sm" data-testid="board-live-events">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-start font-medium">
        <span>{he.liveEvents.title}</span>
        <ChevronDown className={cn("ms-auto size-4 transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && events.length === 0 ? (
        <p className="border-t px-3 py-1.5 text-muted-foreground" data-testid="board-live-events-empty">
          {query.isPending ? he.common.loading : he.liveEvents.empty}
        </p>
      ) : null}
      {open && events.length > 0 ? (
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

