import { CarFront, Pin, Clock3, UserRoundX, Star } from "lucide-react";
import type { MouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { formatMinutes } from "@/components/TimeField15";
import { he } from "@/i18n/he";
import { rideTypeColorClasses } from "@/lib/rideTypeColors";
import { cn } from "@/lib/utils";

/**
 * Cars × time grid for one day (component inventory `WeekGrid`, UX_FLOWS.md
 * §4.2/§3.5/§20 "Vertical board"). **Layout only** — no data fetching, no
 * dialogs, no mutation calls: the Sadran board and the member siddur both
 * reuse this same component, wiring drag/resize/click handlers through props.
 *
 * Owner-requested redesign (UX_FLOWS.md §20): cars are now **columns**
 * across the top, hours are **rows** down the side (a calendar day view).
 * Time flows top→bottom — a plain CSS grid, so unlike the previous
 * horizontal layout (§17's "hour axis" bug, where absolutely-positioned ride
 * blocks and a separately-laid-out flex hour axis used two different,
 * `dir`-mismatched coordinate systems) there is nothing to keep in sync: the
 * vertical (time) axis is never mirrored by `dir`, and each car is its own
 * real DOM column (laid out by ordinary flex/grid flow, which *does* honor
 * `dir` — first car renders at the physical inline-start edge, i.e. the
 * right in RTL, exactly as the owner asked), so no manual physical-offset
 * math is needed for column order either. Ride blocks are absolutely
 * positioned *within* their own car column using top/height percentages
 * (dir-independent, like the old `left`/`width` clamping was).
 */
export interface WeekGridCar {
  id: string;
  name: string;
  /** Temporary cars are tinted and separated with a stronger divider (UX_FLOWS §4.2). */
  group?: "shared" | "temporary" | "phantom";
  /** e.g. "בבנימינה" while away from home — shown next to the car name. */
  locationBadge?: string;
}

export interface WeekGridRide {
  id: string;
  carId: string;
  /** Minutes since local midnight, on the 15-minute grid. May be before `dayStartMinutes` (clamped visually, §20). */
  startMinutes: number;
  endMinutes: number;
  label: string;
  description?: string;
  coordinatorNotes?: string;
  /** An original request time that a nearby drag should snap back to. */
  requestedStartMinutes?: number;
  passengerSummary?: string;
  pinned?: boolean;
  shadowed?: boolean;
  conflict?: boolean;
  pendingConsent?: boolean;
  needsDriver?: boolean;
  isMine?: boolean;
  highlighted?: boolean;
  tightSchedule?: boolean;
  /** `ride_types.code` of the ride's driver request (falls back to any served request, then `"other"`) — tints the block (visual pass, `src/lib/rideTypeColors.ts`). */
  rideTypeCode?: string | null;
}

export interface WeekGridBlock {
  id: string;
  carId: string;
  startMinutes: number;
  endMinutes: number;
  label?: string;
}

export interface WeekGridProps {
  cars: readonly WeekGridCar[];
  rides: readonly WeekGridRide[];
  /** Maintenance/blocked windows, hatched (UX_FLOWS §7.4). */
  blocks?: readonly WeekGridBlock[];
  /** Visible range start. Default 06:00 (UX_FLOWS §20 — "most rides happen 07:00–19:00"); callers pass `department_settings.board_start_time` (falling back to 06:00) or 00:00 once the "הצג שעות מוקדמות" toggle is on. */
  dayStartMinutes?: number;
  /** Grid end, default 24:00. */
  dayEndMinutes?: number;
  readOnly?: boolean;
  onRideClick?: (rideId: string) => void;
  onSlotClick?: (carId: string, minutes: number) => void;
  renderRide?: (ride: WeekGridRide) => ReactNode;
  /**
   * Replaces the plain car-name text (and its car icon) in each column
   * header — the fallback below draws its own `CarFront` + `car.name`, but
   * when this prop is set it fully owns the icon, so the header never draws
   * two car icons side by side. The location badge and temporary-car label
   * below it are unaffected. Stays "layout only": the grid never decides
   * *what* goes here, only where; the member siddur (`SiddurPage`) passes a
   * `CarNameWithReport` here — its own car icon doubles as the "דיווח על
   * רכב" trigger — so the desktop table view can reach that dialog even on
   * a day with no rides to click into (a member self-service action, so the
   * Sadran board never passes this).
   */
  renderCarName?: (car: WeekGridCar) => ReactNode;
  /** Sadran board additions — kept additive and still layout-only: this component only reports the *gesture result*, never calls a mutation or opens a dialog itself. Pointer Events (unified mouse/touch/pen), never native HTML5 DnD (inert on touch). */
  draggable?: boolean;
  canDragRide?: (ride: WeekGridRide) => boolean;
  canResizeRide?: (ride: WeekGridRide) => boolean;
  /** A ride block was dropped on car `carId` at `startMinutes`; `droppedOnRideId` is set when it landed on another block (merge-by-drop). */
  onRideDrop?: (rideId: string, carId: string, startMinutes: number, droppedOnRideId?: string) => void;
  /** One edge (top = start, bottom = end) of a ride block was dragged to a new time (resize). */
  onRideResize?: (rideId: string, edge: "start" | "end", minutes: number) => void;
  /** While dragging `rideId` over `carId`, is this a valid drop target (seat fit, no overlap, no maintenance block)? Defaults to always-valid. */
  resolveDropPreview?: (ride: WeekGridRide, carId: string, startMinutes: number, endMinutes: number, hostRideId?: string) => { startMinutes: number; endMinutes: number };
  isDropTargetValid?: (rideId: string, carId: string, startMinutes: number, endMinutes: number, hostRideId?: string) => boolean;
  /** Live highlight for an external drag in progress over the grid (UX_FLOWS §20 — dragging an unmet request card from `UnmetList`). `null`/absent when none is active. */
  externalDropTarget?: { carId: string; valid: boolean; startMinutes?: number; endMinutes?: number; label?: string } | null;
  /** A ride block was dragged out of the grid and released over `[data-unmet-drop-zone]` (the reverse of `onRideDrop` — UX_FLOWS §20). */
  onRideDropOnUnmet?: (rideId: string) => void;
  /** Minutes-since-midnight for "now", only when the grid's day is today — draws a thin primary line across every column (visual pass). Omit/`null` to hide it (e.g. a past or future day). */
  nowMinutes?: number | null;
  /** When supplied, initially position the grid so this time is the first visible hour below the car headers. */
  initialScrollMinutes?: number | null;
  zoom?: number;
}

/** Any drop target carrying this attribute (e.g. the board's `UnmetList`/drawer) accepts a ride dragged out of the grid — see `onRideDropOnUnmet`. */
export const UNMET_DROP_ZONE_ATTR = "data-unmet-drop-zone";
/** Attribute name each car's own body column carries, for cross-component hit-testing (e.g. `UnmetList` dragging a card *onto* the grid, `document.elementFromPoint(...).closest(...)`). */
export const CAR_COLUMN_ATTR = "data-car-col-id";

const DEFAULT_START = 6 * 60;
const DEFAULT_END = 24 * 60;
const HOUR_COL_WIDTH_PX = 56;
const CAR_COL_WIDTH_PX = 120;
const HEADER_ROW_HEIGHT_PX = 48;
const HOUR_ROW_HEIGHT_PX = 80;
/** 15-min rides still render at least this tall so the label/time stay legible (UX_FLOWS §20). */
const RIDE_MIN_HEIGHT_PX = 26;
/** Below this many minutes of raw (unsnapped) vertical pointer movement, treat a drag as a pure car change — no time shift at all. */
const TIME_SHIFT_DEAD_ZONE_MINUTES = 7.5;
/** Below this many pixels of movement, a pointerdown/up pair is a click, not a drag. */
const DRAG_START_THRESHOLD_PX = 4;

interface ClampedRideRect {
  top: string;
  height: string;
  /** The ride's real `startMinutes` is before the visible range — render the "↑ HH:MM" marker (UX_FLOWS §20). */
  clampedStart: boolean;
}

/** Percentage top/height for a ride within its car column's time axis, clamping to the visible range and flagging an earlier real start. Exported for unit tests. */
export function clampRideVertical(startMinutes: number, endMinutes: number, gridStart: number, gridEnd: number): ClampedRideRect {
  const total = gridEnd - gridStart;
  const top = ((Math.max(startMinutes, gridStart) - gridStart) / total) * 100;
  const height = ((Math.min(endMinutes, gridEnd) - Math.max(startMinutes, gridStart)) / total) * 100;
  return { top: `${top}%`, height: `${Math.max(height, 0.5)}%`, clampedStart: startMinutes < gridStart };
}

/** Physical-top-to-minutes mapping (dir-independent — vertical position is never mirrored by `dir`). Exported for unit tests. */
export function minutesFromClientY(rect: { top: number; height: number }, clientY: number, dayStartMinutes: number, dayEndMinutes: number): number {
  const ratio = rect.height === 0 ? 0 : (clientY - rect.top) / rect.height;
  const minutes = dayStartMinutes + ratio * (dayEndMinutes - dayStartMinutes);
  return Math.round(minutes / 15) * 15;
}

/** Snap a raw (unsnapped) minutes delta to 15 minutes, zeroing anything under half a slot (a car-only, i.e. purely horizontal, drag must not shift time at all). */
export function snapTimeShift(rawDeltaMinutes: number): number {
  if (Math.abs(rawDeltaMinutes) < TIME_SHIFT_DEAD_ZONE_MINUTES) return 0;
  return Math.round(rawDeltaMinutes / 15) * 15;
}

function defaultRenderRide(ride: WeekGridRide) {
  return (
    <span className="flex w-full flex-col items-start overflow-hidden px-1.5 py-1 text-start text-xs font-medium text-foreground">
      <span className={cn("w-full whitespace-normal break-words leading-snug", ride.isMine && "font-bold")}>{ride.label}</span>
      {ride.passengerSummary ? <span className="w-full whitespace-normal break-words text-xs" title={ride.passengerSummary}>{ride.passengerSummary}</span> : null}
      {ride.description ? <span className="line-clamp-2 w-full whitespace-pre-wrap break-words text-xs" title={ride.description}>{ride.description}</span> : null}
      {ride.coordinatorNotes ? <span className="line-clamp-2 w-full whitespace-pre-wrap break-words text-xs" title={`${he.field.notes}: ${ride.coordinatorNotes}`}>{he.field.notes}: {ride.coordinatorNotes}</span> : null}
      <span className={cn("w-full truncate text-[10px] opacity-90", ride.isMine ? "font-bold" : "font-normal")} dir="ltr">
        {formatMinutes(ride.startMinutes)}–{formatMinutes(ride.endMinutes)}
      </span>
    </span>
  );
}

interface DragState {
  rideId: string;
  kind: "move" | "resize-start" | "resize-end";
  pointerId: number;
  originCarId: string;
  originStartMinutes: number;
  originEndMinutes: number;
  /** Screen-space anchors to compute a *delta*, not an absolute drop point. */
  anchorClientX: number;
  anchorClientY: number;
  anchorRect: { top: number; height: number };
  /** Set once the pointer has moved past the click/drag threshold. */
  confirmed: boolean;
  shiftMinutes: number;
  hoverCarId: string | null;
  overRideId: string | null;
}

/**
 * One day, time × cars, bounded to `max-h-[70dvh]` with its own
 * `overflow-auto` (both axes) at every breakpoint — the standard
 * frozen-header/frozen-column pattern (car headers `sticky top-0`, hour
 * column `sticky start-0`, corner cell both). This is a hard CSS constraint,
 * not a style preference: `position: sticky` only tracks the scrolling of
 * its *nearest* scroll-container ancestor (any element whose `overflow` is
 * not `visible`, even if that element's content never actually overflows —
 * confirmed directly, this is the textbook "sticky doesn't stick" gotcha).
 * Previously this bound only applied from `lg:` up, so on a phone (`<lg`)
 * the container had no bounded height, meaning `overflow-auto` was a no-op
 * scroll container that never itself scrolled — the *page* scrolled instead,
 * and since `position: sticky` was still scoped to that inert container, the
 * headers did not track the page's scroll at all (a real, confirmed
 * regression against the "must work on a phone" requirement, not merely a
 * cosmetic gap). Bounding the container at every breakpoint fixes it
 * uniformly and keeps horizontal scrolling for wide fleets working the same
 * way on a phone as on desktop. See UX_FLOWS.md "Page scrolling for the
 * Siddur table" for the doc-side correction.
 */
export function WeekGrid({
  cars,
  rides,
  blocks = [],
  dayStartMinutes = DEFAULT_START,
  dayEndMinutes = DEFAULT_END,
  readOnly = true,
  onRideClick,
  onSlotClick,
  renderRide,
  renderCarName,
  draggable = false,
  canDragRide,
  canResizeRide,
  onRideDrop,
  onRideResize,
  isDropTargetValid,
  resolveDropPreview,
  externalDropTarget = null,
  onRideDropOnUnmet,
  nowMinutes = null,
  initialScrollMinutes = null,
  zoom = 1,
}: WeekGridProps) {
  const hours = Array.from(
    { length: Math.ceil((dayEndMinutes - dayStartMinutes) / 60) },
    (_, i) => Math.floor(dayStartMinutes / 60) + i,
  );

  const sharedCars = cars.filter((c) => c.group !== "temporary" && c.group !== "phantom");
  const phantomCars = cars.filter((c) => c.group === "phantom");
  const temporaryCars = cars.filter((c) => c.group === "temporary");
  const allCars = [...sharedCars, ...temporaryCars, ...phantomCars];

  const rideById = useMemo(() => new Map(rides.map((r) => [r.id, r])), [rides]);
  const colRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const lastInitialScroll = useRef<number | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const suppressClick = useRef(false);

  // Keep the header visible while the hours scroll inside the grid. The target is
  // deliberately below the sticky header: at scrollTop=0 the first time row
  // begins after it, so no extra header-height offset belongs here.
  useEffect(() => {
    if (initialScrollMinutes == null) {
      lastInitialScroll.current = null;
      return;
    }
    if (!scrollViewportRef.current) return;
    const target = Math.min(dayEndMinutes, Math.max(dayStartMinutes, initialScrollMinutes));
    if (lastInitialScroll.current === target) return;
    lastInitialScroll.current = target;
    scrollViewportRef.current.scrollTop = ((target - dayStartMinutes) / 60) * HOUR_ROW_HEIGHT_PX * zoom;
  }, [dayEndMinutes, dayStartMinutes, initialScrollMinutes, zoom]);

  function ridesFor(carId: string) {
    return rides.filter((r) => r.carId === carId);
  }
  function blocksFor(carId: string) {
    return blocks.filter((b) => b.carId === carId);
  }

  /** `onSlotClick` fires regardless of `readOnly` — the published siddur's quick-request-from-empty-slot flow (UX_FLOWS §18) needs it too; only drag/resize are gated by `readOnly`. */
  function handleColumnClick(carId: string, event: MouseEvent<HTMLDivElement>) {
    if (!onSlotClick || suppressClick.current) { suppressClick.current = false; return; }
    const rect = event.currentTarget.getBoundingClientRect();
    onSlotClick(carId, minutesFromClientY(rect, event.clientY, dayStartMinutes, dayEndMinutes));
  }

  const dragEnabled = draggable && !readOnly && !!onRideDrop;
  const resizeEnabled = draggable && !readOnly && !!onRideResize;

  /** Which car column (by horizontal hit-test) is the pointer currently over. */
  function carIdAtClientX(clientX: number): string | null {
    for (const [carId, el] of colRefs.current) {
      const rect = el.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right) return carId;
    }
    return null;
  }

  function rideIdAtPoint(clientX: number, clientY: number, excludeRideId: string): string | null {
    const el = document.elementFromPoint(clientX, clientY);
    const match = el?.closest<HTMLElement>("[data-ride-id]");
    const id = match?.getAttribute("data-ride-id") ?? null;
    return id && id !== excludeRideId ? id : null;
  }

  function unmetDropZoneAtPoint(clientX: number, clientY: number): boolean {
    return !!document.elementFromPoint(clientX, clientY)?.closest(`[${UNMET_DROP_ZONE_ATTR}]`);
  }

  /**
   * `drag` (state, for rendering) and `dragRef` (a live mirror, read inside
   * the window-level listeners below) intentionally track the same value —
   * the window listeners are added imperatively in `beginDrag` and must
   * always see the latest drag state, not whatever was captured in a stale
   * closure from the render that first attached them.
   */
  const dragRef = useRef<DragState | null>(null);

  function finishDrag() {
    dragRef.current = null;
    setDrag(null);
    window.removeEventListener("pointermove", handleWindowMove);
    window.removeEventListener("pointerup", handleWindowUp);
    window.removeEventListener("pointercancel", handleWindowCancel);
  }

  /**
   * Real (not synthetic-only) pointer events, tracked at the `window` level
   * rather than via `setPointerCapture` + per-element `onPointerMove`/
   * `onPointerUp` (the previous implementation): Chromium's CDP-injected
   * synthetic mouse input (`page.mouse.*`, what every e2e drag test and any
   * `playwright`-driven interaction uses) does not honor `setPointerCapture`
   * retargeting — confirmed directly (`hasPointerCapture()` returns `true`
   * right after `pointerdown`, yet the native `pointerup`'s own `target` is
   * still whatever element is physically under the cursor, never the
   * capturing element), so a drag that ends over a *different* element than
   * it started on (every real drag) never reached this component's
   * `onPointerUp` at all. `UnmetList`'s own drag-and-drop (UX_FLOWS §20 item
   * 3) already used window-level listeners for exactly this reason; this
   * makes `WeekGrid`'s ride-to-ride drag/resize consistent with it.
   */
  function handleWindowMove(event: PointerEvent) {
    const current = dragRef.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const movedPx = Math.max(Math.abs(event.clientX - current.anchorClientX), Math.abs(event.clientY - current.anchorClientY));
    const confirmed = current.confirmed || movedPx >= DRAG_START_THRESHOLD_PX;
    const hoverCarId = current.kind === "move" ? carIdAtClientX(event.clientX) : current.originCarId;
    const overRideId = current.kind === "move" ? rideIdAtPoint(event.clientX, event.clientY, current.rideId) : null;
    const shiftMinutes = dragShift(current, event.clientY);
    const next = { ...current, confirmed, hoverCarId, overRideId, shiftMinutes };
    dragRef.current = next;
    setDrag(next);
    if (confirmed) event.preventDefault();
  }

  /** A plain tap (never confirmed into a drag) still opens the ride via `onRideClick` here rather than relying on the native `click` event, matching the previous implementation's own reasoning for that (Chromium suppresses `click` synthesis after any captured/`preventDefault`-ed pointer sequence). */
  function handleWindowUp(event: PointerEvent) {
    const current = dragRef.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const shift = dragShift(current, event.clientY);
    const finished = current;
    suppressClick.current = true;
    finishDrag();
    if (!finished.confirmed) {
      if (finished.kind === "move") onRideClick?.(finished.rideId);
      return;
    }

    if (finished.kind === "move") {
      if (onRideDropOnUnmet && unmetDropZoneAtPoint(event.clientX, event.clientY)) {
        onRideDropOnUnmet(finished.rideId);
        return;
      }
      const carId = carIdAtClientX(event.clientX);
      if (!carId) return;
      onRideDrop?.(finished.rideId, carId, finished.originStartMinutes + shift, finished.overRideId ?? undefined);
    } else if (finished.kind === "resize-start") {
      onRideResize?.(finished.rideId, "start", finished.originStartMinutes + shift);
    } else {
      onRideResize?.(finished.rideId, "end", finished.originEndMinutes + shift);
    }
  }

  function handleWindowCancel(event: PointerEvent) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    finishDrag();
  }

  function dragShift(current: DragState, clientY: number): number {
    const shift = snapTimeShift((clientY - current.anchorClientY) / current.anchorRect.height * (dayEndMinutes - dayStartMinutes));
    if (current.kind === "resize-end" && current.originEndMinutes + shift >= 1439 && dayEndMinutes === 1440) {
      return 1439 - current.originEndMinutes;
    }
    const requestedStart = rideById.get(current.rideId)?.requestedStartMinutes;
    if (current.kind === "move" && requestedStart != null && Math.abs(current.originStartMinutes + shift - requestedStart) <= 15) {
      return requestedStart - current.originStartMinutes;
    }
    return shift;
  }

  function beginDrag(
    event: ReactPointerEvent<HTMLElement>,
    ride: WeekGridRide,
    kind: DragState["kind"],
    colRect: { top: number; height: number },
  ) {
    event.stopPropagation();
    suppressClick.current = false;
    const state: DragState = {
      rideId: ride.id,
      kind,
      pointerId: event.pointerId,
      originCarId: ride.carId,
      originStartMinutes: ride.startMinutes,
      originEndMinutes: ride.endMinutes,
      anchorClientX: event.clientX,
      anchorClientY: event.clientY,
      anchorRect: colRect,
      confirmed: false,
      shiftMinutes: 0,
      hoverCarId: ride.carId,
      overRideId: null,
    };
    dragRef.current = state;
    setDrag(state);
    window.addEventListener("pointermove", handleWindowMove);
    window.addEventListener("pointerup", handleWindowUp);
    window.addEventListener("pointercancel", handleWindowCancel);
  }

  const draggedRide = drag ? rideById.get(drag.rideId) : undefined;
  const rawPreview = drag?.confirmed && draggedRide && drag.hoverCarId
    ? { carId: drag.hoverCarId, label: draggedRide.label,
        startMinutes: drag.originStartMinutes + (drag.kind === "resize-end" ? 0 : drag.shiftMinutes),
        endMinutes: drag.originEndMinutes + (drag.kind === "resize-start" ? 0 : drag.shiftMinutes) }
    : externalDropTarget?.startMinutes != null && externalDropTarget.endMinutes != null
      ? { ...externalDropTarget, startMinutes: externalDropTarget.startMinutes, endMinutes: externalDropTarget.endMinutes }
      : null;
  const preview = rawPreview && draggedRide && drag?.kind === "move" && resolveDropPreview
    ? { ...rawPreview, ...resolveDropPreview(draggedRide, rawPreview.carId, rawPreview.startMinutes, rawPreview.endMinutes, drag.overRideId ?? undefined) }
    : rawPreview;
  const gridTemplateRows = `minmax(${HEADER_ROW_HEIGHT_PX}px, auto) repeat(${hours.length}, ${HOUR_ROW_HEIGHT_PX}px)`;
  const gridTemplateColumns = `${HOUR_COL_WIDTH_PX}px repeat(${allCars.length}, ${CAR_COL_WIDTH_PX}px)`;

  function Column({ car, colIndex }: { car: WeekGridCar; colIndex: number }) {
    const isDragHoverTarget = drag?.confirmed && drag.hoverCarId === car.id;
    const isExternalHover = externalDropTarget?.carId === car.id;
    const hoverValid = isDragHoverTarget
      ? (draggedRide ? (isDropTargetValid?.(draggedRide.id, car.id, rawPreview?.startMinutes ?? draggedRide.startMinutes, rawPreview?.endMinutes ?? draggedRide.endMinutes, drag?.overRideId ?? undefined) ?? true) : true)
      : (externalDropTarget?.valid ?? true);
    const showHoverRing = isDragHoverTarget || isExternalHover;
    const isFirstTemporary = colIndex === sharedCars.length && temporaryCars.length > 0;

    return (
      <div
        key={car.id}
        ref={(el) => {
          if (el) colRefs.current.set(car.id, el);
          else colRefs.current.delete(car.id);
        }}
        data-car-col-id={car.id}
        className={cn(
          "relative border-e transition-smooth",
          car.group === "temporary" && "bg-booked/[0.04]",
          car.group === "phantom" && "border-dashed bg-maintenance/5",
          isFirstTemporary && "border-s-2 border-s-border",
          showHoverRing && (hoverValid ? "bg-available/10 ring-2 ring-inset ring-available" : "bg-destructive/10 ring-2 ring-inset ring-destructive"),
        )}
        style={{ gridColumn: colIndex + 2, gridRow: `2 / span ${hours.length}` }}
        onClick={(e) => handleColumnClick(car.id, e)}
        role={onSlotClick ? "button" : undefined}
      >
        {hours.map((h, hi) => {
          const bandRect = clampRideVertical(h * 60, (h + 1) * 60, dayStartMinutes, dayEndMinutes);
          return (
            <div
              key={`band-${h}`}
              className={cn("absolute inset-x-0", hi % 2 === 1 && "bg-muted/40")}
              style={{ top: bandRect.top, height: bandRect.height }}
              aria-hidden="true"
            />
          );
        })}
        {nowMinutes != null && nowMinutes >= dayStartMinutes && nowMinutes <= dayEndMinutes ? (
          <div
            className="pointer-events-none absolute inset-x-0 z-20 h-0.5 bg-primary shadow-[0_0_4px_hsl(var(--primary)/0.6)]"
            style={{ top: clampRideVertical(nowMinutes, nowMinutes, dayStartMinutes, dayEndMinutes).top }}
            aria-hidden="true"
          />
        ) : null}
        {hours.map((h) => (
          <div
            key={h}
            className="absolute inset-x-0 border-b border-border"
            style={{ top: clampRideVertical(h * 60, h * 60, dayStartMinutes, dayEndMinutes).top }}
            aria-hidden="true"
          />
        ))}
        {blocksFor(car.id).map((b) => {
          const rect = clampRideVertical(b.startMinutes, b.endMinutes, dayStartMinutes, dayEndMinutes);
          return (
            <div
              key={b.id}
              className="absolute inset-x-1 rounded-sm border border-maintenance/60 bg-[repeating-linear-gradient(45deg,hsl(var(--maintenance)/0.35),hsl(var(--maintenance)/0.35)_4px,hsl(var(--maintenance)/0.12)_4px,hsl(var(--maintenance)/0.12)_8px)]"
              style={{ top: rect.top, height: rect.height }}
              title={b.label}
            />
          );
        })}
        {preview?.carId === car.id ? (
          <div data-drag-preview className={cn("pointer-events-none absolute inset-x-1 z-30 overflow-hidden rounded border-2 border-dashed bg-background/80 p-1 text-xs shadow-lg", hoverValid ? "border-primary" : "border-destructive")}
            style={{ top: clampRideVertical(preview.startMinutes, preview.endMinutes, dayStartMinutes, dayEndMinutes).top, height: clampRideVertical(preview.startMinutes, preview.endMinutes, dayStartMinutes, dayEndMinutes).height, minHeight: RIDE_MIN_HEIGHT_PX }}>
            <strong className="block">{car.name}</strong>
            <span dir="ltr" className="block">{formatMinutes(preview.startMinutes)}–{formatMinutes(preview.endMinutes)}</span>
            <span className="whitespace-normal break-words">{preview.label}</span>
          </div>
        ) : null}
        {ridesFor(car.id).map((ride) => {
          const isDragged = drag?.rideId === ride.id && drag.confirmed;
          const rect = clampRideVertical(ride.startMinutes, ride.endMinutes, dayStartMinutes, dayEndMinutes);
          const typeColors = rideTypeColorClasses(ride.rideTypeCode);
          return (
            <button
              key={ride.id}
              type="button"
              data-ride-id={ride.id}
              data-needs-driver={ride.needsDriver || undefined}
              data-my-ride={ride.isMine || undefined}
              data-tight-schedule={ride.tightSchedule || undefined}
              className={cn(
                "absolute inset-x-1 flex flex-col overflow-hidden rounded-sm border-s-4 text-start text-foreground shadow-sm transition-smooth",
                typeColors.bg,
                typeColors.border,
                // Conflict/pinned styling always wins over the ride-type tint (kept last so `cn`/tailwind-merge overrides it).
                ride.conflict &&
                  "border-2 border-destructive bg-[repeating-linear-gradient(45deg,hsl(var(--destructive)/0.25),hsl(var(--destructive)/0.25)_6px,hsl(var(--destructive)/0.08)_6px,hsl(var(--destructive)/0.08)_12px)]",
                ride.pendingConsent && "border-2 border-dashed border-maintenance",
                onRideClick && "cursor-pointer",
                dragEnabled && (canDragRide?.(ride) ?? true) && "touch-none",
                ride.shadowed && "opacity-50",
                ride.isMine && "shadow-md",
                ride.isMine && !ride.needsDriver && "ring-2 ring-primary/60",
                ride.needsDriver && "border-2 border-dashed border-destructive bg-destructive/10",
                ride.highlighted && "z-10 scroll-mt-24 ring-4 ring-destructive ring-offset-2",
                isDragged && "opacity-50 ring-2 ring-primary",
              )}
              style={{ top: rect.top, height: rect.height, minHeight: RIDE_MIN_HEIGHT_PX }}
              title={rect.clampedStart ? `${formatMinutes(ride.startMinutes)}–${formatMinutes(ride.endMinutes)}` : undefined}
              onClick={(e) => {
                e.stopPropagation();
                if (suppressClick.current) { suppressClick.current = false; return; }
                onRideClick?.(ride.id);
              }}
              onPointerDown={(e) => {
                if (!dragEnabled || !(canDragRide?.(ride) ?? true)) return;
                const rect2 = e.currentTarget.parentElement?.getBoundingClientRect();
                if (!rect2) return;
                beginDrag(e, ride, "move", rect2);
              }}
              aria-label={ride.isMine ? `${he.siddur.myRide} · ${ride.label}` : ride.label}
            >
              {(ride.isMine || ride.needsDriver || ride.tightSchedule) ? <span className="flex w-full flex-wrap gap-1 px-1.5 pt-1 text-[10px] leading-tight">
                {ride.isMine ? <span className={cn("flex items-center gap-1 font-bold", ride.needsDriver ? "text-destructive" : "text-foreground")}><Star className="size-3 shrink-0 fill-current" aria-hidden="true" />{he.siddur.myRide}</span> : null}
                {ride.needsDriver ? <span className="flex items-center gap-1 font-semibold text-destructive"><UserRoundX className="size-3 shrink-0" aria-hidden="true" />{he.boardCoordination.needsDriver}</span> : null}
                {ride.tightSchedule ? <span className="flex items-center gap-1 text-amber-700" title={he.boardCoordination.tightHelp}><Clock3 className="size-3 shrink-0" aria-hidden="true" />{he.boardCoordination.tight}</span> : null}
              </span> : null}
              {ride.pinned ? (
                <span className="absolute end-1 top-1 z-10 text-foreground/70" aria-hidden="true">
                  <Pin className="size-3" />
                </span>
              ) : null}
              {rect.clampedStart ? (
                <span className="px-1 pt-0.5 text-[10px] leading-none opacity-90" dir="ltr">
                  ↑ {formatMinutes(ride.startMinutes)}
                </span>
              ) : null}
              {resizeEnabled && (canDragRide?.(ride) ?? true) && (canResizeRide?.(ride) ?? true) ? (
                <span
                  className="absolute inset-x-0 top-0 z-20 h-2.5 cursor-ns-resize touch-none border-y border-foreground/20 bg-foreground/10"
                  aria-hidden="true"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => {
                    const rect2 = e.currentTarget.parentElement?.parentElement?.getBoundingClientRect();
                    if (!rect2) return;
                    beginDrag(e, ride, "resize-start", rect2);
                  }}
                />
              ) : null}
              {renderRide ? renderRide(ride) : defaultRenderRide(ride)}
              {resizeEnabled && (canDragRide?.(ride) ?? true) && (canResizeRide?.(ride) ?? true) ? (
                <span
                  className="absolute inset-x-0 bottom-0 z-20 h-2.5 cursor-ns-resize touch-none border-y border-foreground/20 bg-foreground/10"
                  aria-hidden="true"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => {
                    const rect2 = e.currentTarget.parentElement?.parentElement?.getBoundingClientRect();
                    if (!rect2) return;
                    beginDrag(e, ride, "resize-end", rect2);
                  }}
                />
              ) : null}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div ref={scrollViewportRef} className="min-w-0 max-h-[70dvh] overflow-auto rounded-md border shadow-card" data-week-grid-scroll-viewport>
      <div className="grid" style={{ zoom, gridTemplateColumns, gridTemplateRows, minWidth: HOUR_COL_WIDTH_PX + allCars.length * CAR_COL_WIDTH_PX }}>
        <div className="sticky start-0 top-0 z-30 border-b border-e bg-muted/70 shadow-[0_2px_6px_-2px_hsl(var(--foreground)/0.12)]" style={{ gridColumn: 1, gridRow: 1 }} />
        {allCars.map((car, i) => (
          <div
            key={`h-${car.id}`}
            className={cn(
              "sticky top-0 z-20 flex flex-col justify-center gap-0.5 overflow-hidden border-b border-e bg-muted/70 px-2 py-1 text-sm shadow-[0_2px_6px_-2px_hsl(var(--foreground)/0.12)]",
              car.group === "temporary" && "bg-booked/10",
              i === sharedCars.length && temporaryCars.length > 0 && "border-s-2 border-s-border",
            )}
            style={{ gridColumn: i + 2, gridRow: 1 }}
          >
            <span className="flex min-w-0 items-start gap-1 font-medium leading-tight">
              {renderCarName ? renderCarName(car) : (
                <>
                  <CarFront className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                  <span className="min-w-0 whitespace-normal break-words">{car.name}</span>
                </>
              )}
            </span>
            {car.locationBadge ? <span className="truncate text-xs text-muted-foreground">{car.locationBadge}</span> : null}
            {car.group === "temporary" ? <span className="truncate text-[10px] text-booked">{he.car.type.temporary}</span> : null}
          </div>
        ))}
        {hours.map((h, i) => (
          <div
            key={h}
            className="sticky start-0 z-10 flex items-start justify-end border-b border-e bg-muted/70 px-1.5 pt-0.5 text-xs font-medium text-muted-foreground shadow-[2px_0_6px_-2px_hsl(var(--foreground)/0.12)]"
            style={{ gridColumn: 1, gridRow: i + 2 }}
          >
            <span dir="ltr">{formatMinutes(h * 60)}</span>
          </div>
        ))}
        {allCars.map((car, i) => (
          Column({ car, colIndex: i })
        ))}
      </div>
    </div>
  );
}
