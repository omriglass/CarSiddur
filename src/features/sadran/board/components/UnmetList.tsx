import { GripVertical } from "lucide-react";
import { useRef, useState } from "react";

import { CAR_COLUMN_ATTR } from "@/components/WeekGrid";
import { minutesFromClientY } from "@/components/weekGridGeometry";
import { StatusBadge } from "@/components/StatusBadge";
import { TripTypeChange } from "./TripTypeChange";
import { WithdrawDuplicateAction } from "./WithdrawDuplicateAction";
import { FewerDaysAction, type FewerDaysSupport } from "./FewerDaysAction";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { he, tv } from "@/i18n/he";
import { weekdayLabel } from "@/lib/dayLabels";
import { rideTypeColorClasses } from "@/lib/rideTypeColors";
import { formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { ridePassengerSummary } from "@/lib/ridePassengerSummary";

import { enteredTimeLabels } from "@/features/requests/enteredTimes";
import { WindowSummaryLine } from "@/features/requests/components/WindowSummaryLine";
import { requestStart, requestWindow, tripTypeOf } from "../phantomLanes";
import { unmetItemKey } from "../unmetLegs";
import { requestRouteLine } from "../requestRoute";
import { fallbackLine, hasActiveFallback } from "../planBLine";

import type { WeekRequestRow } from "../../api";
import { viaLabel } from "@/lib/routeLabel";
import { isActiveStop } from "@/lib/routeStops";

/** An unmet request's own active stops by name, per leg in route order (raw `request_stops` rows). */
function unmetViaNames(
  stops: readonly { leg: "out" | "return"; position: number; place_id: string | null; place_text?: string | null; place?: { name: string } | null }[] | undefined,
  hasReturn: boolean,
): { out: string[]; return: string[] } {
  const via = { out: [] as string[], return: [] as string[] };
  for (const stop of [...(stops ?? [])].sort((a, b) => a.position - b.position)) {
    if (!isActiveStop(stop, hasReturn)) continue;
    const name = stop.place?.name ?? stop.place_text ?? "";
    if (name) via[stop.leg].push(name);
  }
  return via;
}
import type { Suggestion, UnmetRequest } from "@/solver";

export interface UnmetListItem {
  request: WeekRequestRow;
  /**
   * REQ §13.94 (G4): set only on the two cards of a drop-off with a pickup (`out` = the drop-off,
   * `return` = the pickup); `request` is then the one-leg view of that leg (`unmetLegs.ts`).
   */
  leg?: "out" | "return";
  /** A sent/accepted proposal for this request (REQ §13.94): the card offers "בטל הצעה" instead of waiting silently. */
  pendingProposalId?: string;
  destinationName: string;
  /** Present only once a client-side solve has run this session (SOLVER.md §2 `UnmetRequest`). */
  solverInfo?: UnmetRequest;
  /**
   * REQUIREMENTS §13.93 "Multi-stop rides" §6.3 "Joining at a stop": parallel array to
   * `solverInfo.suggestions` — a ready-made "עולה ב<place>" string for a merge suggestion
   * that boards the guest somewhere other than the host's own origin, `null`/absent otherwise.
   */
  suggestionBoardAt?: (string | null)[];
}

/** "יום ג' 09:00" — Asia/Jerusalem-zoned, never a raw `getDay()` (CLAUDE.md hard rule 6). */
function dayTimeLabel(departAt: string | null): string {
  if (!departAt) return "—";
  return `${weekdayLabel(departAt, "short")} ${formatTime(new Date(departAt))}`;
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
  /** REQ §13.95 (H3): scope for the per-card "סוג נסיעה" selector; the selector is hidden without it. */
  tripTypeScope?: { departmentId: string; weekStart: string };
  /** REQ §13.101 (j): enables "להציע פחות ימים" on multi-day requests. */
  fewerDays?: FewerDaysSupport;
  /** Opens the board's proposal sheet (withdraw) for a card that has a proposal out. */
  onOpenProposal?: (proposalId: string) => void;
  /** Drag-to-place; the board chooses direct assignment or a proposal for one-way legs. */
  dayStartMinutes?: number;
  dayEndMinutes?: number;
  onDragHover?: (item: UnmetListItem, carId: string | null, minutes: number | null, rideId?: string) => void;
  onDragDrop?: (item: UnmetListItem, carId: string, minutes: number, rideId?: string) => void;
  /**
   * The "לא שובצו (N)" heading. Defaults on (the phone list-mode segment and the ride-detail
   * sheet's single-item view rely on this component owning its own heading), but the desktop
   * board's side panel (`BoardScreen.tsx`) renders that exact same title itself right above this
   * list — pass `false` there so it isn't duplicated.
   */
  showHeading?: boolean;
  /** REQUIREMENTS §13.93: shows "מ<origin>" on a card whose request origin isn't the department home. */
  homeDestinationId?: string;
}

/**
 * Side panel/drawer `UnmetList` (UX_FLOWS.md §4.2/§20): every request of the
 * week with no ride (bug #1), sorted by policy score when a solver preview
 * exists for it, otherwise by departure time.
 */
export function UnmetList({ items, onAction, onOpenProposal, onDecision, dayStartMinutes = 6 * 60, dayEndMinutes = 23 * 60 + 59, onDragHover, onDragDrop, showHeading = true, homeDestinationId, tripTypeScope, fewerDays }: UnmetListProps) {
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

  function hoverCarIdAt(clientX: number, clientY: number): { carId: string; minutes: number; rideId?: string } | null {
    const hit = document.elementFromPoint(clientX, clientY);
    const el = hit?.closest<HTMLElement>(`[${CAR_COLUMN_ATTR}]`);
    if (!el) return null;
    const carId = el.getAttribute(CAR_COLUMN_ATTR);
    if (!carId) return null;
    const rect = el.getBoundingClientRect();
    return { carId, minutes: minutesFromClientY(rect, clientY, dayStartMinutes, dayEndMinutes), rideId: hit?.closest<HTMLElement>("[data-ride-id]")?.getAttribute("data-ride-id") ?? undefined };
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
    if (hover) onDragDrop?.(finished.item, hover.carId, hover.minutes, hover.rideId);
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
    onDragHover?.(next.item, hover?.carId ?? null, hover?.minutes ?? null, hover?.rideId);
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
      {showHeading ? <h2 className="text-sm font-medium">{tv("sadranBoard.unmetTitle", { count: String(items.length) })}</h2> : null}
      {sorted.map((item) => {
        const isDraggable = dragEnabled;
        const isDragged = drag?.confirmed && unmetItemKey(drag.item) === unmetItemKey(item);
        return (
          <Card
            key={unmetItemKey(item)}
            data-request-id={item.request.id}
            data-unmet-leg={item.leg}
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
                    {item.leg ? <span className="me-1 rounded-sm bg-muted px-1 text-xs" data-testid="unmet-leg-tag">{item.leg === "out" ? he.tripLegs.out : he.tripLegs.pickup}</span> : null}
                    {item.request.requester_full_name ?? "—"} · {item.destinationName}
                  </span>
                </span>
                <StatusBadge kind="request" status={item.request.status} />
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span dir="ltr">{dayTimeLabel(requestStart(item.request))}</span>
                <span>
                  {item.request.ride_type_name_he ?? ""}
                  {/* The stops by name, like the ride cards (owner 2026-10-05: not a count). */}
                  {(() => {
                    const via = viaLabel(unmetViaNames(item.request.stops, item.request.return_at != null));
                    return via ? ` · ${via}` : "";
                  })()}
                </span>
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
              <div className="flex flex-wrap gap-1">
                <Button size="sm" variant="outline" onClick={() => onDecision ? onDecision(item, "shift") : onAction(item, null)}>{he.sadranProposal.suggestTimes}</Button>
                {/* REQ §13.112 (b): "אסתדר" -- no external / public-transport actions on this card (the Sadran can still refuse it). */}
                {item.request.fallback === "manage" && hasActiveFallback(item.request) ? null : (
                  <Button size="sm" variant="outline" disabled={!onDecision} onClick={() => onDecision?.(item, "external")}>{he.sadranProposal.solveOutside}</Button>
                )}
              </div>
              {tripTypeScope && !item.pendingProposalId ? (
                <TripTypeChange
                  requestId={item.request.id}
                  version={item.request.version}
                  tripType={item.request.trip_type}
                  name={item.request.requester_full_name ?? ""}
                  departmentId={tripTypeScope.departmentId}
                  weekStart={tripTypeScope.weekStart}
                  wasUnplaced
                />
              ) : null}
              {fewerDays && !item.pendingProposalId && item.request.series_id ? <FewerDaysAction request={item.request} support={fewerDays} /> : null}
              {tripTypeScope && !item.pendingProposalId && !item.request.series_id ? (
                <WithdrawDuplicateAction
                  requestId={item.request.id}
                  version={item.request.version}
                  name={item.request.requester_full_name ?? ""}
                  departmentId={tripTypeScope.departmentId}
                  weekStart={tripTypeScope.weekStart}
                />
              ) : null}
              {item.pendingProposalId && onOpenProposal ? (
                <div className="flex items-center justify-between gap-2 rounded-md border border-dashed border-maintenance p-2 text-xs" data-testid="unmet-proposal-out">
                  <span>{he.boardDrafts.proposalOut}</span>
                  <Button size="sm" variant="outline" className="min-h-11" onClick={() => onOpenProposal(item.pendingProposalId as string)} data-testid="unmet-withdraw">{he.boardDrafts.withdraw}</Button>
                </div>
              ) : null}
              {item.request.has_luggage ? <span className="text-xs font-medium" data-testid="unmet-luggage">{item.request.luggage_waived_at ? he.smallTrunk.waivedLabel : he.request.luggageChip}</span> : null}
              {item.request.is_late ? <span className="text-xs font-medium text-maintenance">{he.flag.late}</span> : null}
              {item.request.changed_since_solve ? <span className="text-xs font-medium text-booked">{he.flag.changed}</span> : null}
              {item.request.preferred_car_name ? (
                <p className="text-xs text-muted-foreground">
                  {tv("sadranBoard.preferredCar", { car: item.request.preferred_car_name })}
                </p>
              ) : null}
              {/* REQUIREMENTS §13.93: the request's own origin, shown only when it isn't the
                  department home — a free-text origin (never auto-placed, solver reason
                  `UNMET_FREE_TEXT_ORIGIN`) is visibly flagged rather than silently blended in. */}
              <p className="text-xs text-muted-foreground" data-testid="unmet-route-line">
                {requestRouteLine({ originId: item.request.origin_id, originName: item.request.origin_id ? item.request.origin_resolved_name : null, destination: item.destinationName, tripType: item.request.trip_type }, homeDestinationId)}
              </p>
              {(() => {
                const entered = enteredTimeLabels({
                  departAnchor: item.request.depart_anchor,
                  arriveBy: item.request.arrive_by,
                  returnAnchor: item.request.return_anchor,
                  leaveDestAt: item.request.leave_dest_at,
                  destinationName: item.destinationName,
                  isPickup: item.request.trip_type === "drop_off",
                });
                return entered.out || entered.return ? (
                  <p className="text-xs font-medium" data-testid="unmet-entered-times">{[entered.out, entered.return].filter(Boolean).join(" · ")}</p>
                ) : null;
              })()}
              {fallbackLine(item.request) ? (
                <p className="text-xs font-medium" data-testid="unmet-fallback">{fallbackLine(item.request)}</p>
              ) : null}
              <WindowSummaryLine
                row={{ durationLocked: item.request.duration_locked, departAt: item.request.depart_at, returnAt: item.request.return_at, flexReturnLate: item.request.flex_return_late }}
                testId="unmet-window"
              />
              {!item.request.origin_id && item.request.origin_text ? (
                <p className="text-xs font-medium text-destructive">
                  {tv("sadranBoard.unmetFreeTextOrigin", { place: item.request.origin_text })}
                </p>
              ) : null}
              <p className="whitespace-pre-wrap break-words text-xs">{ridePassengerSummary([{ ...item.request, requester: item.request.requester_full_name }])}</p>
              {item.request.ride_description ? <p className="whitespace-pre-wrap break-words text-xs">{item.request.ride_description}</p> : null}
              {item.request.notes ? <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground"><span className="font-medium">{he.field.notes}: </span>{item.request.notes}</p> : null}
              {item.solverInfo?.reason ? <p className="text-xs text-muted-foreground">{item.solverInfo.reason}</p> : null}
              {item.solverInfo?.suggestions.length ? (
                <div className="space-y-1 border-t pt-1">
                  <p className="text-xs font-medium text-muted-foreground">{he.sadranBoard.suggestionsLabel}</p>
                  {item.solverInfo.suggestions.map((suggestion, index) => (
                    <div key={index} className="flex items-center justify-between gap-2 text-xs text-muted-foreground" data-suggestion-kind={suggestion.kind}>
                      <span>
                        {suggestion.kind === "useAlternative" ? <span className="me-1 rounded-sm bg-muted px-1 font-medium text-foreground" data-testid="unmet-plan-b-possible">{he.sadranPlanB.possible}</span> : null}
                        {suggestion.reason}
                        {item.suggestionBoardAt?.[index] ? ` · ${item.suggestionBoardAt[index]}` : ""}
                      </span>
                      <Button size="sm" variant="ghost" onClick={() => onAction(item, suggestion)} data-testid={suggestion.kind === "useAlternative" ? "unmet-plan-b-propose" : undefined}>{suggestion.kind === "useAlternative" ? he.sadranPlanB.propose : he.action.propose}</Button>
                    </div>
                  ))}
                </div>
              ) : null}
              {dragEnabled && tripTypeOf(item.request) !== "round_trip" ? (
                <p className="text-xs text-muted-foreground">{he.sadranBoard.dragOneWayUnsupported}</p>
              ) : null}


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
