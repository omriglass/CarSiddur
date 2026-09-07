import { getDay } from "date-fns";
import { toZonedTime } from "date-fns-tz";
import { GripVertical } from "lucide-react";
import { useRef, useState } from "react";

import { CAR_COLUMN_ATTR, minutesFromClientY } from "@/components/WeekGrid";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { he, tv } from "@/i18n/he";
import { rideTypeColorClasses } from "@/lib/rideTypeColors";
import { TZ, formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";

import { requestStart, requestWindow } from "../phantomLanes";

import type { WeekRequestRow } from "../../api";
import type { Suggestion, UnmetRequest } from "@/solver";

export interface UnmetListItem {
  request: WeekRequestRow;
  destinationName: string;
  /** Present only once a client-side solve has run this session (SOLVER.md §2 `UnmetRequest`). */
  solverInfo?: UnmetRequest;
}

/** "יום ג' 09:00" — Asia/Jerusalem-zoned, never a raw `getDay()` (CLAUDE.md hard rule 6). */
function dayTimeLabel(departAt: string | null): string {
  if (!departAt) return "—";
  const zoned = toZonedTime(new Date(departAt), TZ);
  const day = he.days.short[getDay(zoned)] ?? "";
  return `${day} ${formatTime(new Date(departAt))}`;
}

/** Below this many pixels of raw movement, a touch pointerdown is still a scroll attempt — cancel the pending long-press. */
const TOUCH_SCROLL_CANCEL_PX = 10;
/** Touch needs a deliberate long-press before a drag starts (UX_FLOWS §20) so the list still scrolls normally otherwise. */
const LONG_PRESS_MS = 350;
/** Mouse/pen confirm a drag immediately on movement past this small threshold — no long-press needed (nothing to scroll past). */
const MOUSE_DRAG_CONFIRM_PX = 6;

interface DragState {
  item: UnmetListItem;
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  confirmed: boolean;
}

interface UnmetListProps {
  items: readonly UnmetListItem[];
  onDecision?: (item: UnmetListItem, type: "deny" | "shift" | "external") => void;
  onAction: (item: UnmetListItem, suggestion: Suggestion | null) => void;
  /** Drag-to-place; the board chooses direct assignment or a proposal for one-way legs. */
  dayStartMinutes?: number;
  dayEndMinutes?: number;
  onDragHover?: (item: UnmetListItem, carId: string | null, minutes: number | null) => void;
  onDragDrop?: (item: UnmetListItem, carId: string, minutes: number) => void;
}

function suggestionActionLabel(kind: Suggestion["kind"]): string {
  switch (kind) {
    case "shiftWithinFlex":
      return he.action.apply;
    case "merge":
    case "shiftBeyondFlex":
    case "splitLegs":
    case "convertToRoundTrip":
      return he.action.propose;
    case "chauffeur":
      return he.action.propose;
    case "externalHint":
      return he.action.markExternal;
    case "deny":
      return he.action.deny;
  }
}

/**
 * Side panel/drawer `UnmetList` (UX_FLOWS.md §4.2/§20): every request of the
 * week with no ride (bug #1), sorted by policy score when a solver preview
 * exists for it, otherwise by departure time.
 */
export function UnmetList({ items, onAction, onDecision, dayStartMinutes = 6 * 60, dayEndMinutes = 24 * 60, onDragHover, onDragDrop }: UnmetListProps) {
  const dragEnabled = !!onDragDrop;
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sorted = [...items].sort((a, b) => {
    if (a.solverInfo && b.solverInfo) return b.solverInfo.score - a.solverInfo.score;
    if (a.solverInfo || b.solverInfo) return a.solverInfo ? -1 : 1;
    return (a.request.depart_at ?? "").localeCompare(b.request.depart_at ?? "");
  });

  function clearLongPress() {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  function hoverCarIdAt(clientX: number, clientY: number): { carId: string; minutes: number } | null {
    const el = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(`[${CAR_COLUMN_ATTR}]`);
    if (!el) return null;
    const carId = el.getAttribute(CAR_COLUMN_ATTR);
    if (!carId) return null;
    const rect = el.getBoundingClientRect();
    return { carId, minutes: minutesFromClientY(rect, clientY, dayStartMinutes, dayEndMinutes) };
  }

  function endDrag(commit: boolean) {
    const finished = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    window.removeEventListener("pointermove", handleWindowMove);
    window.removeEventListener("pointerup", handleWindowUp);
    window.removeEventListener("pointercancel", handleWindowCancel);
    if (!finished?.confirmed) return;
    onDragHover?.(finished.item, null, null);
    if (!commit) return;
    const hover = hoverCarIdAt(finished.clientX, finished.clientY);
    if (hover) onDragDrop?.(finished.item, hover.carId, hover.minutes);
  }

  function handleWindowMove(event: PointerEvent) {
    const current = dragRef.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const movedPx = Math.max(Math.abs(event.clientX - current.clientX), Math.abs(event.clientY - current.clientY));
    if (!current.confirmed) {
      if (current.pointerType === "touch") {
        // Long-press not fired yet and the finger moved enough to be a scroll — cancel silently.
        if (movedPx >= TOUCH_SCROLL_CANCEL_PX) {
          clearLongPress();
          dragRef.current = null;
          setDrag(null);
          window.removeEventListener("pointermove", handleWindowMove);
          window.removeEventListener("pointerup", handleWindowUp);
          window.removeEventListener("pointercancel", handleWindowCancel);
        }
        return;
      }
      if (movedPx < MOUSE_DRAG_CONFIRM_PX) return;
      current.confirmed = true;
    }
    const next = { ...current, clientX: event.clientX, clientY: event.clientY };
    dragRef.current = next;
    setDrag(next);
    const hover = hoverCarIdAt(event.clientX, event.clientY);
    onDragHover?.(next.item, hover?.carId ?? null, hover?.minutes ?? null);
    event.preventDefault();
  }

  function handleWindowUp(event: PointerEvent) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    clearLongPress();
    endDrag(true);
  }

  function handleWindowCancel(event: PointerEvent) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    clearLongPress();
    endDrag(false);
  }

  function beginPointerDown(item: UnmetListItem, event: React.PointerEvent<HTMLElement>) {
    if (!dragEnabled) return;
    const state: DragState = {
      item,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      clientX: event.clientX,
      clientY: event.clientY,
      confirmed: false,
    };
    dragRef.current = state;
    setDrag(state);
    window.addEventListener("pointermove", handleWindowMove);
    window.addEventListener("pointerup", handleWindowUp);
    window.addEventListener("pointercancel", handleWindowCancel);
    if (event.pointerType === "touch") {
      clearLongPress();
      longPressTimer.current = setTimeout(() => {
        if (dragRef.current?.pointerId === event.pointerId) {
          dragRef.current = { ...dragRef.current, confirmed: true };
          setDrag(dragRef.current);
        }
      }, LONG_PRESS_MS);
    } else {
      event.preventDefault();
    }
  }

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium">{tv("sadranBoard.unmetTitle", { count: String(items.length) })}</h2>
      {sorted.map((item) => {
        const isDraggable = dragEnabled;
        const isDragged = drag?.confirmed && drag.item.request.id === item.request.id;
        return (
          <Card
            key={item.request.id}
            data-request-id={item.request.id}
            className={cn("bg-gradient-card shadow-card transition-smooth", isDragged && "opacity-50")}
          >
            <CardContent className="space-y-2 p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={cn("size-2.5 shrink-0 rounded-full", rideTypeColorClasses(item.request.ride_type_code).dot)}
                    aria-hidden="true"
                  />
                  {isDraggable ? (
                    <span
                      className="shrink-0 cursor-grab touch-none text-muted-foreground active:cursor-grabbing"
                      role="button"
                      aria-label={he.sadranBoard.dragHandleLabel}
                      onPointerDown={(e) => beginPointerDown(item, e)}
                    >
                      <GripVertical className="size-4" aria-hidden="true" />
                    </span>
                  ) : null}
                  <span className="whitespace-normal break-words font-medium">
                    {item.request.requester_full_name ?? "—"} · {item.destinationName}
                  </span>
                </span>
                <StatusBadge kind="request" status={item.request.status} />
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span dir="ltr">{dayTimeLabel(requestStart(item.request))}</span>
                <span>{item.request.ride_type_name_he ?? ""}</span>
                {item.solverInfo ? (
                  <span dir="ltr">
                    {he.sadranBoard.scoreLabel} {item.solverInfo.score.toFixed(2)}
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground" dir="ltr">
                {requestWindow(item.request) ? `${formatTime(new Date(requestWindow(item.request)!.startsAt))}–${formatTime(new Date(requestWindow(item.request)!.endsAt))}` : "—"}
                {item.request.trip_shape !== "round_trip" ? ` · ${(item.request.trip_shape === "one_way_from" ? he.request.tripShapeOneWayFrom : he.request.tripShapeOneWayTo)} · ${he.sadranBoard.estimatedDuration}` : ""}
              </p>
              {onDecision ? <div className="flex flex-wrap gap-1">
                <Button size="sm" variant="outline" onClick={() => onDecision(item, "deny")}>{he.action.deny}</Button>
                <Button size="sm" variant="outline" onClick={() => onDecision(item, "external")}>{he.sadranBoard.alternative}</Button>
                <Button size="sm" variant="outline" onClick={() => onDecision(item, "shift")}>{he.sadranBoard.changeHours}</Button>
              </div> : null}
              {item.request.is_late ? <span className="text-xs font-medium text-maintenance">{he.flag.late}</span> : null}
              {item.request.changed_since_solve ? <span className="text-xs font-medium text-booked">{he.flag.changed}</span> : null}
              {item.request.preferred_car_name ? (
                <p className="text-xs text-muted-foreground">
                  {tv("sadranBoard.preferredCar", { car: item.request.preferred_car_name })}
                </p>
              ) : null}
              {item.solverInfo?.reason ? <p className="text-xs text-muted-foreground">{item.solverInfo.reason}</p> : null}
              {dragEnabled && item.request.trip_shape !== "round_trip" ? (
                <p className="text-xs text-muted-foreground">{he.sadranBoard.dragOneWayUnsupported}</p>
              ) : null}

              <div className="space-y-1">
                {item.solverInfo && item.solverInfo.suggestions.length > 0 ? (
                  item.solverInfo.suggestions.map((s, i) => (
                    <div key={i} className="flex items-center justify-between gap-2">
                      <span className="text-xs">{s.reason}</span>
                      <Button size="sm" variant="outline" onClick={() => onAction(item, s)}>
                        {suggestionActionLabel(s.kind)}
                      </Button>
                    </div>
                  ))
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">{he.sadranBoard.noSuggestions}</span>
                    <Button size="sm" variant="outline" onClick={() => onAction(item, null)}>
                      {he.action.propose}
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
      {drag?.confirmed ? (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded-md border bg-popover opacity-50 px-3 py-1.5 text-xs shadow-lg"
          style={{ left: drag.clientX, top: drag.clientY }}
        >
          {drag.item.request.requester_full_name ?? "—"} · {drag.item.destinationName}
        </div>
      ) : null}
    </div>
  );
}
