import { CarFront, ChevronDown, Pin, Clock3, UserRoundX, Star, X } from "lucide-react";
import type { MouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Fragment, useEffect, useMemo, useRef, useState, useCallback, useSyncExternalStore } from "react";

import { edgeScrollStep } from "@/components/dragAutoScroll";
import { nextZoom } from "@/components/pinchZoom";
import { ScaledGrid } from "@/components/ScaledGrid";
import { formatMinutes } from "@/components/timeField15Format";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { CarReportDialog } from "@/features/carCare/components/CarReportDialog";
import { he, tv } from "@/i18n/he";
import { rideTypeColorClasses } from "@/lib/rideTypeColors";
import { cn } from "@/lib/utils";
import { GuestChips, type GuestDropTarget, type WeekGridGuest } from "./GuestChips";
import { bottomNavInset, pageScroller, scrollerViewport } from "./pageScroller";
import { DraftWatermark } from "./DraftWatermark";
import { itemVisibilityStyle } from "./itemVisibility";
import { RideNotes } from "./RideNotes";
import { RideDeltaLine } from "./RideDeltaLine";
import type { RideDeltaView } from "@/features/sadran/requestDelta";
import { clampRideVertical, minutesFromClientY, snapTimeShift } from "./weekGridGeometry";

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
  /** e.g. "בבנימינה" while away from its base — shown next to the car name. */
  locationBadge?: string;
  /** REQUIREMENTS §13.93: the car's own base, shown only when it differs from the department home (e.g. "בסיס: בנימינה"). */
  baseBadge?: string;
  /**
   * REQUIREMENTS §13.93/SOLVER.md §1.3a `weekEndAway()`: the car ends the *week* away from its
   * base — a warning only (never a block); the caller only sets this while rendering the last
   * day of the week.
   */
  weekEndAwayWarning?: string;
  /** Owner 2026-10-11 ("my rides" week view, columns = days): today's column header is marked like "my car" (lilac, bold). */
  today?: boolean;
  /** Owner 2026-10-26 (`/my` week view, columns = days): this day is not published yet — a draft stamp over its column. */
  unpublished?: boolean;
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
  /** REQ §13.161 (a): requested -> got, beyond flexibility only (Sadran board). */
  delta?: RideDeltaView | null;
  pinned?: boolean;
  shadowed?: boolean;
  conflict?: boolean;
  pendingConsent?: boolean;
  /**
   * REQ §13.94: an unsent proposal (board draft) drawn as the result it would produce — a dashed
   * primary outline plus a "טיוטה" tag, distinct from conflict stripes and from the sent
   * `pendingConsent` dash.
   */
  draft?: boolean;
  /**
   * REQ §13.94 (G10): the block is a merged ride (an applied merge, or a draft/sent merge drawn
   * as the ride it would become) - one block on the base car with a small "· מאוחד" marker.
   */
  merged?: boolean;
  /** REQ §13.95 (H2): one half of a connected הקפצה pair (small "מחובר" marker). */
  connected?: boolean;
  /** The added people of a merged block, drawn as draggable chips (REQ §13.94 G10). */
  guests?: readonly WeekGridGuest[];
  needsDriver?: boolean;
  /** A served request carries large luggage (REQ §13.100, 101 a): small "ציוד גדול" chip. */
  luggage?: boolean;
  /** REQ §13.111 (a): all of the ride's large luggage was waived by hand - the chip reads `he.smallTrunk.waivedLabel`. */
  luggageWaived?: boolean;
  isMine?: boolean;
  /** Owner 2026-10-16: a read-only ride of my child / their other guardian on "my rides" — drawn faded, never "mine". */
  muted?: boolean;
  highlighted?: boolean;
  tightSchedule?: boolean;
  /** `ride_types.code` of the ride's driver request (falls back to any served request, then `"other"`) — tints the block (visual pass, `src/lib/rideTypeColors.ts`). */
  rideTypeCode?: string | null;
  /** Multi-day request leg (REQ §13.77, UX_FLOWS.md §4.2) — 1-based position and total leg count; shows a "יום {{index}}/{{count}}" marker on the block when `seriesCount` is above 1. */
  seriesIndex?: number | null;
  seriesCount?: number | null;
  /**
   * REQUIREMENTS §13.93, SOLVER.md §1.3a `CarTimeline.chainBreaks()`: this (fixed) ride starts
   * where its car's tracked location says it is not — a warning only, never a block. Already
   * resolved Hebrew text (e.g. "הרכב לא נמצא כאן — הוא בבנימינה").
   */
  chainBrokenWarning?: string;
  /** Owner 2026-10-16: the same driver is on another overlapping ride (warning only, never blocks). */
  driverOverlapWarning?: string;
  /** Owner 2026-10-16, "my rides" week view: the "!" be-back-on-time lines (already worded, `carHandoverLines`). */
  handoverLines?: readonly string[];
  /**
   * Owner 2026-10-11, "my rides" week view: what the block is when it is not a placed ride — a repeating-request
   * suggestion (dotted, pale, "הצעה" on top: never mistaken for a request), a Sadran proposal awaiting my answer,
   * a request on the waiting list, or a filed request not placed yet. Absent = a ride, drawn as on the siddur.
   */
  kind?: WeekGridItemKind;
  /** Side-by-side lanes for blocks that overlap in one column (a day can hold several of my items; a car never does). 0-based. */
  lane?: number;
  laneCount?: number;
}

export type WeekGridItemKind = "suggestion" | "proposal" | "waiting" | "request";

/**
 * A faint, non-interactive background block (owner 2026-10-11: the member's own calendar behind the "my rides" week
 * view — `features/calendar`). Drawn under everything else, never a click or drop target.
 */
export interface WeekGridAmbientBlock {
  id: string;
  carId: string;
  startMinutes: number;
  endMinutes: number;
  /** The event title. */
  label: string;
  /** Extra lines under the title, already formatted, in display order (hours, location, participants, notes). */
  lines?: string[];
  /** CSS color of the event; used only when present (the caller applies the member's "use calendar colors" choice). */
  color?: string;
  /** Drawn as a thin band at the top of the day instead of a timed block (`startMinutes`/`endMinutes` are ignored). */
  allDay?: boolean;
  /** Side-by-side lanes for overlapping events of one day (0-based), like `WeekGridRide.lane`. */
  lane?: number;
  laneCount?: number;
}

/** Height of one stacked all-day band, px. */
const ALL_DAY_BAND_PX = 18;

export interface WeekGridBlock {
  id: string;
  carId: string;
  startMinutes: number;
  endMinutes: number;
  label?: string;
  /**
   * `"maintenance"` (default, unchanged styling: hatched maintenance-color band, label only as
   * a tooltip) or `"away"` (REQ §89, owner 2026-09-15: the car is away at a destination between
   * a relay out-leg and its return — a hatched, muted band with the label drawn on the block
   * itself, not just a tooltip, so the grid never shows the gap as an empty/vacant column).
   * Both kinds are equally non-interactive and an equally invalid drop target
   * (`board/dropValidity.ts`).
   */
  kind?: "maintenance" | "away";
  /**
   * REQ §13.114: a maintenance period the viewer may move/resize (the car's current responsible person, the
   * Sadran, the admin — decided by the caller; the server re-checks). Read-only bands omit it.
   */
  editable?: boolean;
  /** The period starts before / ends after this grid's day: that edge has no resize handle here. `startMinutes`/`endMinutes` stay the true (unclamped) values. */
  clippedStart?: boolean;
  clippedEnd?: boolean;
}

/** Which part of a maintenance band a drag moved (REQ §13.114): the whole band, or one edge. */
export type WeekGridBlockEdge = "move" | "start" | "end";

interface BlockDragState {
  blockId: string;
  kind: WeekGridBlockEdge;
  confirmed: boolean;
  delta: number;
}

/**
 * One "בדיון" contested waiting-list group (REQ §13.75, UX_FLOWS.md
 * §3.5/§4.2), rendered in a dedicated lane after every car column — it has
 * no car of its own yet, so it cannot live inside a car column like
 * `WeekGridRide`/`WeekGridBlock`. `startMinutes`/`endMinutes` are already
 * minutes-since-midnight on this grid's own day (the caller converts the
 * group's `starts_at`/`ends_at`, same as it does for rides — WeekGrid stays
 * time-zone-unaware, CLAUDE.md "Time").
 */
export interface WeekGridDiscussionBlock {
  id: string;
  startMinutes: number;
  endMinutes: number;
  label: string;
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
  /**
   * Owner 2026-10-11: choose a time span by tapping twice on empty space in one column — the first tap marks the start
   * (a line + "התחלה 08:00 · הקש/י על שעת הסיום" + ×), the second the end. Tapping the start slot again gives
   * `endMinutes === startMinutes` (the caller applies its default length). A tap in another column moves the start
   * there; a ride tap, Escape, the × or a new `rangeResetKey` clears it. When set, it replaces `onSlotClick`.
   */
  onSlotRange?: (carId: string, startMinutes: number, endMinutes: number) => void;
  /** Clears a half-chosen span when it changes (e.g. the caller's shown day). */
  rangeResetKey?: string;
  /** Faint background blocks (the member's calendar), under the rides. */
  ambientBlocks?: readonly WeekGridAmbientBlock[];
  /** "Visibility aid" over `ambientBlocks` (owner 2026-10-12): 0–100, 50 = normal (`itemVisibility.ts`); absent = 50. */
  itemVisibility?: number;
  /**
   * Bold + lilac header for every column holding one of my rides (default). Off for the "my rides" week view, whose
   * columns are days and every ride is mine — there only `WeekGridCar.today` is marked (owner 2026-10-11).
   */
  markMyColumns?: boolean;
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
  /** REQ §13.94 (G10): a merged block's chip is being dragged over `target` (`null` = over nothing) - live preview. */
  onGuestHover?: (guest: WeekGridGuest, target: GuestDropTarget | null) => void;
  /** A chip was dropped: on the unmet list / a phantom lane (`unmet`), or on a car column at `minutes` (maybe on another ride). */
  onGuestDrop?: (guest: WeekGridGuest, target: GuestDropTarget) => void;
  /** Minutes-since-midnight for "now", only when the grid's day is today — draws a thin primary line across every column (visual pass). Omit/`null` to hide it (e.g. a past or future day). */
  nowMinutes?: number | null;
  /**
   * Start of the quarter hour "now" is in (07:58 → 07:45), when the grid shows today: that quarter of the
   * hour column is tinted lilac and labelled, like today's column header (owner 2026-10-13, `/my` week view).
   */
  nowQuarterMinutes?: number | null;
  /** Owner 2026-10-26: the shown day is not published yet — a draft stamp over the whole grid (siddur table view). */
  watermark?: boolean;
  /** When supplied, initially position the grid so this time is the first visible hour below the car headers. */
  initialScrollMinutes?: number | null;
  zoom?: number;
  /** Owner 2026-10-22: `drafting` (the Sadran board) draws the grid lines as wide-gap dashes — a drafting table. */
  surface?: "published" | "drafting";
  /**
   * Two-finger pinch on the grid's own scroll container calls this with the live zoom
   * (`components/pinchZoom.ts`, clamped 0.5–1.5). Omit to leave pinch disabled (e.g. the
   * Sadran board, which has no pinch requirement) — the ± buttons keep working either way.
   */
  onZoomChange?: (zoom: number) => void;
  /** A maintenance band (`editable` ones only) was dragged: `deltaMinutes` (a 15-minute multiple) applies to the whole band or one edge. Layout-only like `onRideDrop` — the caller calls the server. */
  onBlockChange?: (blockId: string, edge: WeekGridBlockEdge, deltaMinutes: number) => void;
  /** An `editable` maintenance band was clicked / tapped / activated by keyboard (opens the period dialog — the non-drag path, also the only one on touch). */
  onBlockClick?: (blockId: string) => void;
  /** Contested waiting-list groups for the displayed day (REQ §13.75); omit/empty to hide the lane entirely. */
  discussionBlocks?: readonly WeekGridDiscussionBlock[];
  onDiscussionClick?: (id: string) => void;
  /**
   * Swap cars on a day by dragging car names (REQ §13.92, owner batch
   * 2026-09-24 S1): car column headers become drag sources *and* drop
   * targets, plus a small "החלף רכב" menu on each header for keyboard/touch
   * users who never drag. `WeekGrid` always renders exactly one day (see the
   * component doc above), so there is no per-day ambiguity here — the
   * caller (`BoardScreen`'s selected day tab / `SiddurPage`'s active day)
   * already knows which day this instance is showing and supplies it to the
   * dialog it opens in response to `onCarSwap`. Applies to real (non-phantom)
   * cars only; a phantom "candidate" lane is never a swap source or target.
   * False/omitted leaves headers exactly as before (no drag, no menu).
   */
  canSwapCars?: boolean;
  /**
   * Shows "דיווח / טיפול ברכב" in each real car's header menu and owns the `CarReportDialog` it opens
   * (member self-service: report a problem / tire fill / wash). The grid still never mutates by itself.
   */
  enableCarReport?: boolean;
  /** Shows "דף הרכב" in each real car's header menu; the caller navigates (`paths.car(carId)`). */
  onOpenCarPage?: (carId: string) => void;
  /** Header `carIdA` was dropped onto header `carIdB` (drag), or `carIdB` was chosen from `carIdA`'s own menu — the caller opens `CarSwapDialog` with these two ids. */
  onCarSwap?: (carIdA: string, carIdB: string) => void;
}

/** Any drop target carrying this attribute (e.g. the board's `UnmetList`/drawer) accepts a ride dragged out of the grid — see `onRideDropOnUnmet`. */
export const UNMET_DROP_ZONE_ATTR = "data-unmet-drop-zone";
/** Attribute name each car's own body column carries, for cross-component hit-testing (e.g. `UnmetList` dragging a card *onto* the grid, `document.elementFromPoint(...).closest(...)`). */
export const CAR_COLUMN_ATTR = "data-car-col-id";

const DEFAULT_START = 6 * 60;
const DEFAULT_END = 24 * 60;
/** "23:00" in text-xs (12px) tabular-nums is ~31px wide (5 glyphs of ~6.1px, digits are the widest); +2px slack and 1px each side of padding (`px-px`) plus the 1px end border. Narrower than this clips the label. */
const HOUR_COL_WIDTH_PX = 36;
const CAR_COL_WIDTH_PX = 96;
const HEADER_ROW_HEIGHT_PX = 48;
const DESKTOP_QUERY = "(min-width: 1024px)";
function subscribeDesktop(cb: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(DESKTOP_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
/**
 * Owner 2026-10-10: on a phone the table scrolls with the page too (ONE scroller), exactly like `lg`+:
 * no `max-h-[70dvh]` box, car names in a `sticky` strip outside the box. Set to `false` to restore the
 * old phone behaviour (self-scrolling box bounded to 70dvh, in-grid sticky header) in one line.
 * (`AppShell`'s `main` drops its own `overflow-y` below `lg` so the sticky strip tracks the document.)
 */
export const PAGE_SCROLL_ON_PHONE = true;

/** Tailwind `lg` and up: the table is part of the page (see `WeekGrid`). */
function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribeDesktop, () => typeof window.matchMedia === "function" && window.matchMedia(DESKTOP_QUERY).matches, () => false);
}

const HOUR_ROW_HEIGHT_PX = 80;
/** 15-min rides still render at least this tall so the label/time stay legible (UX_FLOWS §20). */
const RIDE_MIN_HEIGHT_PX = 32;
/** R4U1: a ride this short or shorter gets slim resize handles so most of the card stays a click target. */
const SHORT_RIDE_MINUTES = 30;
/** Below this many pixels of movement, a pointerdown/up pair is a click, not a drag. */
const DRAG_START_THRESHOLD_PX = 4;
/** A scroll this soon after the ride popup opened does not close it (layout settling, not the user). */
const PEEK_SCROLL_GRACE_MS = 300;
/**
 * Car-header drag (REQ §13.92): same touch-vs-mouse gesture split as
 * `UnmetList`'s own drag-and-drop (`sadran/board/components/UnmetList.tsx`)
 * — a long-press on touch (so the header row still scrolls normally
 * otherwise), immediate confirm-on-move for mouse/pen (nothing to scroll
 * past). Duplicated locally rather than imported: `WeekGrid` stays
 * layout-only and `UnmetList` is board-specific.
 */
const CAR_TOUCH_SCROLL_CANCEL_PX = 10;
const CAR_LONG_PRESS_MS = 350;
const CAR_MOUSE_DRAG_CONFIRM_PX = 6;

function defaultRenderRide(ride: WeekGridRide) {
  return (
    <span className="flex min-h-0 w-full shrink flex-col items-start overflow-hidden px-1.5 py-1 text-start text-xs font-medium text-foreground">
      <span className={cn("w-full shrink-0 whitespace-normal break-words leading-snug", ride.isMine && "font-bold")}>{ride.label}</span>
      {ride.seriesCount && ride.seriesCount > 1 ? (
        <span className="w-full shrink-0 truncate text-xs opacity-90">{tv("ride.seriesDay", { index: String(ride.seriesIndex ?? 1), count: String(ride.seriesCount) })}</span>
      ) : null}
      {ride.passengerSummary ? <span className="w-full shrink-0 whitespace-normal break-words text-xs" title={ride.passengerSummary}>{ride.passengerSummary}</span> : null}
      <RideDeltaLine view={ride.delta} />
      {/* Owner 2026-10-22: notes take whatever height the block leaves (they were cut at two lines); the click popup shows them whole. */}
      {ride.description || ride.coordinatorNotes ? (
        <RideNotes>
          {ride.description ? <span className="w-full whitespace-pre-wrap break-words text-xs" title={ride.description}>{ride.description}</span> : null}
          {ride.coordinatorNotes ? <span className="w-full whitespace-pre-wrap break-words text-xs" title={`${he.field.notes}: ${ride.coordinatorNotes}`}>{he.field.notes}: {ride.coordinatorNotes}</span> : null}
        </RideNotes>
      ) : null}
      <span className={cn("w-full shrink-0 truncate text-[10px] opacity-90", ride.isMine ? "font-bold" : "font-normal")} dir="ltr">
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
  /** Scroll offset of the grid viewport at pointer-down, so auto-scroll during the drag still maps to the right time. */
  anchorScrollTop: number;
  /** Set once the pointer has moved past the click/drag threshold. */
  confirmed: boolean;
  shiftMinutes: number;
  hoverCarId: string | null;
  overRideId: string | null;
}

/** One in-progress car-header drag (REQ §13.92) — see the const block above for the gesture split. */
interface CarDragState {
  carId: string;
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  confirmed: boolean;
  /** Recomputed on every `pointermove` (an event handler, so reading `colRefs` there is fine) — never derived at render time, which would read a ref during render. */
  hoverCarId: string | null;
}

/**
 * One day, time × cars. At every width (owner 2026-10-10, `PAGE_SCROLL_ON_PHONE`; computers since
 * 2026-10-06, REQ §13.106) the table is part of the page: the box has no height bound and scrolls only
 * horizontally, the page scrolls vertically (`main#main-content` on `lg`+, the document below — see
 * `pageScroller`), and the car-name header row is rendered *outside* the box as a `sticky` strip
 * (`top-14` under the phone app header, `top-0` from `md`; its `scrollLeft` follows the box's).
 * Drag auto-scroll, drag-anchor compensation and the initial scroll follow the page scroller.
 * With the switch off the box is bounded to `max-h-[70dvh]` and scrolls itself below `lg`.
 * See UX_FLOWS.md "Page scrolling for the Siddur table".
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
  onSlotRange,
  rangeResetKey,
  ambientBlocks = [],
  itemVisibility,
  markMyColumns = true,
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
  onGuestHover,
  onGuestDrop,
  nowMinutes = null,
  nowQuarterMinutes = null,
  watermark = false,
  initialScrollMinutes = null,
  zoom = 1,
  surface = "published",
  onZoomChange,
  discussionBlocks = [],
  onBlockChange,
  onBlockClick,
  onDiscussionClick,
  canSwapCars = false,
  onCarSwap,
  enableCarReport,
  onOpenCarPage,
}: WeekGridProps) {
  const drafting = surface === "drafting";
  const hours = Array.from(
    { length: Math.ceil((dayEndMinutes - dayStartMinutes) / 60) },
    (_, i) => Math.floor(dayStartMinutes / 60) + i,
  );

  const sharedCars = cars.filter((c) => c.group !== "temporary" && c.group !== "phantom");
  // Cars the viewer rides in on the shown day: their header name is bold (owner 2026-10-09).
  const myCarIds = new Set(markMyColumns ? rides.filter((ride) => ride.isMine).map((ride) => ride.carId) : []);
  const phantomCars = cars.filter((c) => c.group === "phantom");
  const temporaryCars = cars.filter((c) => c.group === "temporary");
  const allCars = [...sharedCars, ...temporaryCars, ...phantomCars];

  const rideById = useMemo(() => new Map(rides.map((r) => [r.id, r])), [rides]);
  const colRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const [notesPeek, setNotesPeek] = useState<{ rideId: string; el: HTMLElement } | null>(null);
  const notesPeekRef = useRef<HTMLDivElement | null>(null);
  // Owner 2026-10-22: the popup never blocks the screen — any scroll (page or grid, not the popup's own) closes it,
  // and so does a finger drag on a phone even when nothing scrolls (a page edge, a ride being dragged on the board).
  useEffect(() => {
    if (!notesPeek) return;
    const insidePopup = (event: Event) => event.target instanceof Node && !!notesPeekRef.current?.contains(event.target);
    // The grid itself may still be settling (header scroll sync, the board re-rendering) right after the tap.
    const openedAt = Date.now();
    const close = (event: Event) => {
      if (!insidePopup(event) && Date.now() - openedAt > PEEK_SCROLL_GRACE_MS) setNotesPeek(null);
    };
    let touchStart: { x: number; y: number } | null = null;
    const onTouchStart = (event: TouchEvent) => {
      const t = event.touches[0];
      touchStart = t && !insidePopup(event) ? { x: t.clientX, y: t.clientY } : null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const t = event.touches[0];
      if (touchStart && t && Math.hypot(t.clientX - touchStart.x, t.clientY - touchStart.y) > DRAG_START_THRESHOLD_PX * 2) setNotesPeek(null);
    };
    window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    window.addEventListener("touchmove", onTouchMove, { capture: true, passive: true });
    return () => {
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("touchstart", onTouchStart, { capture: true });
      window.removeEventListener("touchmove", onTouchMove, { capture: true });
    };
  }, [notesPeek]);
  // REQ §13.106: on a computer the table is part of the page (the page scrolls vertically, the car
  // names are pinned above the box); below `lg` the box scrolls itself.
  const isDesktopWidth = useIsDesktop();
  /** Layout switch: the page scrolls vertically and the car names sit in a sticky strip above the box. */
  const pageScroll = PAGE_SCROLL_ON_PHONE || isDesktopWidth;
  const headerRef = useRef<HTMLDivElement | null>(null);
  const setScrollViewport = useCallback((node: HTMLDivElement | null) => { scrollViewportRef.current = node; }, []);
  /** The element that scrolls the table vertically: the page scroller (`main` on `lg`+, the document below) in page-scroll layout, else the box. */
  function verticalScroller(): HTMLElement | null {
    const box = scrollViewportRef.current;
    if (!box) return null;
    return pageScroll ? pageScroller(box) : box;
  }
  /** Distance from the top of the visible page area to the bottom of the sticky car-name strip (0 in box layout). */
  function stickyHeaderInset(): number {
    const strip = headerRef.current;
    if (!strip) return 0;
    return (Number.parseFloat(getComputedStyle(strip).top) || 0) + strip.getBoundingClientRect().height;
  }
  const lastInitialScroll = useRef<number | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  /** Owner 2026-10-11: the first tap of a two-tap span (`onSlotRange`); `null` while none is half-chosen. */
  const [rangeStart, setRangeStart] = useState<{ carId: string; minutes: number } | null>(null);
  /** With a mouse (a computer), where the span would end if clicked now — the preview box follows the cursor. */
  const [rangeHover, setRangeHover] = useState<number | null>(null);
  const [lastRangeResetKey, setLastRangeResetKey] = useState(rangeResetKey);
  if (rangeResetKey !== lastRangeResetKey) {
    setLastRangeResetKey(rangeResetKey);
    setRangeStart(null);
    setRangeHover(null);
  }
  useEffect(() => {
    if (!rangeStart) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { setRangeStart(null); setRangeHover(null); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rangeStart]);
  const [blockDrag, setBlockDrag] = useState<BlockDragState | null>(null);
  const suppressBlockClick = useRef(false);
  const [carDrag, setCarDrag] = useState<CarDragState | null>(null);
  /** Car whose header menu is open / whose report dialog is open (controlled: Radix would open on pointerdown, which must stay free for the long-press swap drag). */
  const [menuCarId, setMenuCarId] = useState<string | null>(null);
  const [reportCarId, setReportCarId] = useState<string | null>(null);
  /** A confirmed header drag ends with a click on the trigger; swallow it. */
  const suppressCarClickRef = useRef(false);
  const carDragRef = useRef<CarDragState | null>(null);
  const carLongPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    const offset = ((target - dayStartMinutes) / 60) * HOUR_ROW_HEIGHT_PX * zoom;
    const box = scrollViewportRef.current;
    const page = pageScroll ? pageScroller(box) : null;
    if (page) {
      // The row `offset` below the box's top goes right under the pinned header (and the app header above it).
      page.scrollTop += box.getBoundingClientRect().top + offset - scrollerViewport(page).top - stickyHeaderInset();
    } else {
      box.scrollTop = offset;
    }
  }, [dayEndMinutes, dayStartMinutes, initialScrollMinutes, zoom, pageScroll]);

  // Two-finger pinch-to-zoom (UX_FLOWS.md member siddur "pinch to zoom"). Registered once as
  // native listeners (never React's synthetic touch handlers, which Chromium treats as
  // passive by default, silently ignoring `preventDefault()`) so `touchmove` can suppress the
  // browser's own page-pinch while two fingers are down without fighting normal one-finger
  // panning (`touchAction: "pan-x pan-y"` below). Reads `zoom`/`onZoomChange` off refs kept
  // fresh every render instead of depending on them directly — depending on `zoom` would tear
  // down and rebuild the listeners (losing the in-progress pinch anchor) on every frame of the
  // very gesture they're driving, since each `onZoomChange` call re-renders this component with
  // a new `zoom` prop.
  const zoomRef = useRef(zoom);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  const onZoomChangeRef = useRef(onZoomChange);
  useEffect(() => { onZoomChangeRef.current = onZoomChange; }, [onZoomChange]);
  useEffect(() => {
    const el = scrollViewportRef.current;
    if (!el) return;
    let pinch: { startDist: number; startZoom: number } | null = null;
    let rafId = 0;

    function touchDistance(touches: TouchList): number {
      const a = touches.item(0);
      const b = touches.item(1);
      if (!a || !b) return 0;
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }
    function handleTouchStart(e: TouchEvent) {
      if (e.touches.length === 2) pinch = { startDist: touchDistance(e.touches), startZoom: zoomRef.current };
    }
    function handleTouchMove(e: TouchEvent) {
      if (e.touches.length !== 2 || !pinch || !onZoomChangeRef.current) return;
      e.preventDefault();
      const dist = touchDistance(e.touches);
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (pinch) onZoomChangeRef.current?.(nextZoom(pinch.startZoom, pinch.startDist, dist));
      });
    }
    function handleTouchEnd(e: TouchEvent) {
      if (e.touches.length < 2) pinch = null;
    }

    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchmove", handleTouchMove, { passive: false });
    el.addEventListener("touchend", handleTouchEnd, { passive: true });
    el.addEventListener("touchcancel", handleTouchEnd, { passive: true });
    return () => {
      cancelAnimationFrame(rafId);
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchmove", handleTouchMove);
      el.removeEventListener("touchend", handleTouchEnd);
      el.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, []);

  // QU1: auto-scroll the grid while any drag (ride, car header, unmet-list item) is held near
  // an edge of the viewport. The pointer is tracked at window level; a requestAnimationFrame loop
  // scrolls and then re-evaluates the hover state with the same pointer position.
  const moveRef = useRef<(event: PointerEvent) => void>(() => {});
  const dragActive = !!drag?.confirmed || !!carDrag?.confirmed || !!externalDropTarget;
  useEffect(() => {
    if (!dragActive) return;
    const el = scrollViewportRef.current;
    if (!el) return;
    let last: PointerEvent | null = null;
    let rafId = 0;
    const onMove = (e: PointerEvent) => { last = e; };
    function tick() {
      if (el && last) {
        const rect = el.getBoundingClientRect();
        const dx = edgeScrollStep(last.clientX, rect.left, rect.right);
        const page = pageScroll ? pageScroller(el) : null;
        const pageView = page ? scrollerViewport(page) : null;
        const dy = pageView
          ? edgeScrollStep(last.clientY, pageView.top + stickyHeaderInset(), pageView.bottom - bottomNavInset())
          : edgeScrollStep(last.clientY, rect.top, rect.bottom);
        if (dx || dy) {
          // R3B17: auto-scroll never brings the "missing car" lanes into view (they are drop targets
          // for un-assigning, reached on purpose, not by an edge scroll).
          const phantom = dx ? el.querySelector<HTMLElement>('[data-car-col-id^="phantom:"]') : null;
          const phantomVisible = () => {
            if (!phantom) return false;
            const box = phantom.getBoundingClientRect();
            return box.left < rect.right && box.right > rect.left;
          };
          const wasVisible = phantomVisible();
          if (page) { page.scrollBy(0, dy); el.scrollBy(dx, 0); } else el.scrollBy(dx, dy);
          if (phantom && !wasVisible && phantomVisible()) el.scrollBy(-dx, 0);
          if (dragRef.current) moveRef.current(last);
        }
      }
      rafId = requestAnimationFrame(tick);
    }
    window.addEventListener("pointermove", onMove);
    rafId = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(rafId);
    };
  }, [dragActive, pageScroll]);

  function ridesFor(carId: string) {
    return rides.filter((r) => r.carId === carId);
  }
  function blocksFor(carId: string) {
    return blocks.filter((b) => b.carId === carId);
  }

  /** `onSlotClick` fires regardless of `readOnly` — the published siddur's quick-request-from-empty-slot flow (UX_FLOWS §18) needs it too; only drag/resize are gated by `readOnly`. */
  function handleColumnClick(carId: string, event: MouseEvent<HTMLDivElement>) {
    if ((!onSlotClick && !onSlotRange) || suppressClick.current) { suppressClick.current = false; return; }
    const rect = event.currentTarget.getBoundingClientRect();
    const minutes = minutesFromClientY(rect, event.clientY, dayStartMinutes, dayEndMinutes);
    if (!onSlotRange) { onSlotClick?.(carId, minutes); return; }
    // Two taps: the first marks the start (or moves it to another column), the second closes the span either way round.
    setRangeHover(null);
    if (!rangeStart || rangeStart.carId !== carId) { setRangeStart({ carId, minutes }); return; }
    setRangeStart(null);
    onSlotRange(carId, Math.min(rangeStart.minutes, minutes), Math.max(rangeStart.minutes, minutes));
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

  /** REQ §13.94: what a dragged guest chip is over - the unmet list / a phantom lane, or a car column (+ the ride under it). */
  function guestTargetAt(clientX: number, clientY: number): GuestDropTarget | null {
    if (unmetDropZoneAtPoint(clientX, clientY)) return { kind: "unmet" };
    const hit = document.elementFromPoint(clientX, clientY);
    const column = hit?.closest<HTMLElement>(`[${CAR_COLUMN_ATTR}]`);
    const carId = column?.getAttribute(CAR_COLUMN_ATTR);
    if (!column || !carId) return null;
    if (carId.startsWith("phantom:")) return { kind: "unmet" };
    const minutes = Math.round(minutesFromClientY(column.getBoundingClientRect(), clientY, dayStartMinutes, dayEndMinutes) / 15) * 15;
    const rideId = hit?.closest<HTMLElement>("[data-ride-id]")?.getAttribute("data-ride-id");
    return { kind: "car", carId, minutes, hostRideId: rideId && !rideId.includes(":") ? rideId : undefined };
  }

  function unmetDropZoneAtPoint(clientX: number, clientY: number): boolean {
    return !!document.elementFromPoint(clientX, clientY)?.closest(`[${UNMET_DROP_ZONE_ATTR}]`);
  }

  /** A real (non-phantom) car, i.e. a valid car-swap source/target (REQ §13.92). */
  function isSwappableCarId(carId: string | null): carId is string {
    return !!carId && (allCars.find((c) => c.id === carId)?.group !== "phantom");
  }

  function clearCarLongPress() {
    if (carLongPressTimer.current) {
      clearTimeout(carLongPressTimer.current);
      carLongPressTimer.current = null;
    }
  }

  function endCarDrag(commit: boolean) {
    const finished = carDragRef.current;
    carDragRef.current = null;
    setCarDrag(null);
    window.removeEventListener("pointermove", handleCarWindowMove);
    window.removeEventListener("pointerup", handleCarWindowUp);
    window.removeEventListener("pointercancel", handleCarWindowCancel);
    if (finished?.confirmed) {
      suppressCarClickRef.current = true;
      setTimeout(() => { suppressCarClickRef.current = false; }, 100);
    }
    if (!finished?.confirmed || !commit) return;
    if (isSwappableCarId(finished.hoverCarId) && finished.hoverCarId !== finished.carId) onCarSwap?.(finished.carId, finished.hoverCarId);
  }

  function handleCarWindowMove(event: PointerEvent) {
    const current = carDragRef.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const movedPx = Math.max(Math.abs(event.clientX - current.clientX), Math.abs(event.clientY - current.clientY));
    if (!current.confirmed) {
      if (current.pointerType === "touch") {
        // Long-press not fired yet and the finger moved enough to be a scroll — cancel silently.
        if (movedPx >= CAR_TOUCH_SCROLL_CANCEL_PX) {
          clearCarLongPress();
          carDragRef.current = null;
          setCarDrag(null);
          window.removeEventListener("pointermove", handleCarWindowMove);
          window.removeEventListener("pointerup", handleCarWindowUp);
          window.removeEventListener("pointercancel", handleCarWindowCancel);
        }
        return;
      }
      if (movedPx < CAR_MOUSE_DRAG_CONFIRM_PX) return;
      current.confirmed = true;
    }
    const next = { ...current, clientX: event.clientX, clientY: event.clientY, hoverCarId: carIdAtClientX(event.clientX) };
    carDragRef.current = next;
    setCarDrag(next);
    event.preventDefault();
  }

  function handleCarWindowUp(event: PointerEvent) {
    if (carDragRef.current?.pointerId !== event.pointerId) return;
    clearCarLongPress();
    endCarDrag(true);
  }

  function handleCarWindowCancel(event: PointerEvent) {
    if (carDragRef.current?.pointerId !== event.pointerId) return;
    clearCarLongPress();
    endCarDrag(false);
  }

  function beginCarPointerDown(carId: string, event: ReactPointerEvent<HTMLElement>) {
    if (!canSwapCars || !onCarSwap) return;
    event.stopPropagation();
    const state: CarDragState = {
      carId,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      clientX: event.clientX,
      clientY: event.clientY,
      confirmed: false,
      hoverCarId: carId,
    };
    carDragRef.current = state;
    setCarDrag(state);
    window.addEventListener("pointermove", handleCarWindowMove);
    window.addEventListener("pointerup", handleCarWindowUp);
    window.addEventListener("pointercancel", handleCarWindowCancel);
    if (event.pointerType === "touch") {
      clearCarLongPress();
      carLongPressTimer.current = setTimeout(() => {
        if (carDragRef.current?.pointerId === event.pointerId) {
          carDragRef.current = { ...carDragRef.current, confirmed: true };
          setCarDrag(carDragRef.current);
        }
      }, CAR_LONG_PRESS_MS);
    } else {
      event.preventDefault();
    }
  }

  /**
   * `drag` (state, for rendering) and `dragRef` (a live mirror, read inside
   * the window-level listeners below) intentionally track the same value —
   * the window listeners are added imperatively in `beginDrag` and must
   * always see the latest drag state, not whatever was captured in a stale
   * closure from the render that first attached them.
   */
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

  /**
   * Opens a ride (owner 2026-10-22): a first click or tap on a block shows its summary in a small popup (`notesPeek`
   * — label, time, people, notes in full); the popup's button, or a second click on the same block, opens the ride
   * (its details / edit sheet via `onRideClick`).
   */
  function openRide(rideId: string) {
    const el = scrollViewportRef.current?.querySelector<HTMLElement>(`[data-ride-id="${rideId.replace(/"/g, '\\"')}"]`) ?? null;
    if (el && notesPeek?.rideId !== rideId) {
      setNotesPeek({ rideId, el });
      return;
    }
    setNotesPeek(null);
    onRideClick?.(rideId);
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
      if (finished.kind === "move") openRide(finished.rideId);
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
    const scrolled = (verticalScroller()?.scrollTop ?? current.anchorScrollTop) - current.anchorScrollTop;
    const shift = snapTimeShift((clientY - current.anchorClientY + scrolled) / current.anchorRect.height * (dayEndMinutes - dayStartMinutes));
    if (current.kind === "resize-end" && current.originEndMinutes + shift >= 1439 && dayEndMinutes === 1440) {
      return 1439 - current.originEndMinutes;
    }
    const requestedStart = rideById.get(current.rideId)?.requestedStartMinutes;
    if (current.kind === "move" && requestedStart != null && Math.abs(current.originStartMinutes + shift - requestedStart) <= 15) {
      return requestedStart - current.originStartMinutes;
    }
    return shift;
  }

  /**
   * Maintenance band gesture (REQ §13.114): same Pointer Events + window-level listeners as the ride drag above
   * (synthetic mouse input does not honour pointer capture). `kind` "move" shifts the whole band, "start"/"end" one
   * edge; the delta is snapped to 15 minutes and clamped so the band never gets shorter than 15 minutes. Vertical only —
   * a band belongs to its car. Touch only starts from the edge handles (the body must still scroll the grid); a tap on
   * the body is a click.
   */
  function beginBlockDrag(event: ReactPointerEvent<HTMLElement>, block: WeekGridBlock, kind: WeekGridBlockEdge, colEl: HTMLElement | null) {
    event.stopPropagation();
    if (!colEl || !onBlockChange) return;
    if (kind === "move" && event.pointerType === "touch") return;
    const rect = colEl.getBoundingClientRect();
    const total = dayEndMinutes - dayStartMinutes;
    const pointerId = event.pointerId;
    const startY = event.clientY;
    const anchorScroll = verticalScroller()?.scrollTop ?? 0;
    const duration = block.endMinutes - block.startMinutes;
    let state: BlockDragState = { blockId: block.id, kind, confirmed: false, delta: 0 };
    suppressBlockClick.current = false;
    const compute = (clientY: number) => {
      const scrolled = (verticalScroller()?.scrollTop ?? anchorScroll) - anchorScroll;
      let delta = snapTimeShift(((clientY - startY + scrolled) / rect.height) * total);
      if (kind === "start") delta = Math.min(delta, duration - 15);
      if (kind === "end") delta = Math.max(delta, -(duration - 15));
      return delta;
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      setBlockDrag(null);
    };
    function onMove(e: PointerEvent) {
      if (e.pointerId !== pointerId) return;
      const confirmed = state.confirmed || Math.abs(e.clientY - startY) >= DRAG_START_THRESHOLD_PX;
      state = { ...state, confirmed, delta: compute(e.clientY) };
      setBlockDrag(state);
      if (confirmed) e.preventDefault();
    }
    function onUp(e: PointerEvent) {
      if (e.pointerId !== pointerId) return;
      const finished = { ...state, delta: compute(e.clientY) };
      cleanup();
      if (!finished.confirmed) return; // a plain tap: the element's own onClick opens the dialog
      suppressBlockClick.current = true;
      if (finished.delta !== 0) onBlockChange?.(block.id, kind, finished.delta);
    }
    function onCancel(e: PointerEvent) {
      if (e.pointerId === pointerId) cleanup();
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
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
      anchorScrollTop: verticalScroller()?.scrollTop ?? 0,
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

  useEffect(() => { moveRef.current = handleWindowMove; });
  const carPointerDownRef = useRef(beginCarPointerDown);
  useEffect(() => { carPointerDownRef.current = beginCarPointerDown; });

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
  /** Which car header the pointer is over, tracked on `carDrag` itself (never derived at render time — that would read the `colRefs` ref during render). */
  const carDragHoverId = carDrag?.confirmed ? carDrag.hoverCarId : null;
  const hasDiscussionLane = discussionBlocks.length > 0;
  const discussionColIndex = allCars.length + 2;
  const gridTemplateRows = `${pageScroll ? "0px" : `minmax(${HEADER_ROW_HEIGHT_PX}px, auto)`} repeat(${hours.length}, ${HOUR_ROW_HEIGHT_PX}px)`;
  const gridMinWidth = HOUR_COL_WIDTH_PX + (allCars.length + (hasDiscussionLane ? 1 : 0)) * CAR_COL_WIDTH_PX;
  const gridTemplateColumns = `${HOUR_COL_WIDTH_PX}px repeat(${allCars.length}, minmax(${CAR_COL_WIDTH_PX}px, 1fr))${hasDiscussionLane ? ` minmax(${CAR_COL_WIDTH_PX}px, 1fr)` : ""}`;

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
          "relative transition-smooth",
          !drafting && "border-e",
          car.group === "temporary" && "bg-booked/[0.04]",
          car.group === "phantom" && "border-dashed bg-maintenance/5",
          isFirstTemporary && "border-s-2 border-s-border",
          showHoverRing && (hoverValid ? "bg-available/10 ring-2 ring-inset ring-available" : "bg-destructive/10 ring-2 ring-inset ring-destructive"),
        )}
        style={{ gridColumn: colIndex + 2, gridRow: `2 / span ${hours.length}` }}
        onClick={(e) => handleColumnClick(car.id, e)}
        onPointerMove={rangeStart?.carId === car.id ? (e) => {
          if (e.pointerType !== "mouse") return;
          const next = minutesFromClientY(e.currentTarget.getBoundingClientRect(), e.clientY, dayStartMinutes, dayEndMinutes);
          setRangeHover((prev) => (prev === next ? prev : next));
        } : undefined}
        onPointerLeave={rangeStart?.carId === car.id ? () => setRangeHover(null) : undefined}
        role={onSlotClick || onSlotRange ? "button" : undefined}
      >
        {drafting ? <div className="draft-line-v pointer-events-none absolute inset-y-0 end-0 w-px" aria-hidden="true" /> : null}
        {car.unpublished ? <DraftWatermark compact /> : null}
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
            className={cn("absolute inset-x-0", drafting ? "draft-line-h h-px" : "border-b border-border")}
            style={{ top: clampRideVertical(h * 60, h * 60, dayStartMinutes, dayEndMinutes).top }}
            aria-hidden="true"
          />
        ))}
        {(() => {
          let allDayIndex = 0;
          return ambientBlocks.filter((a) => a.carId === car.id).map((a) => {
            // Owner 2026-10-12: a sky tint next to the lilac (`--calendar`, both themes) or, when the member chose the
            // calendar's own colors, that color faintly; title (+ lines) centered; always under the rides.
            const tint = a.color
              ? { backgroundColor: `color-mix(in srgb, ${a.color} 16%, transparent)`, borderColor: `color-mix(in srgb, ${a.color} 50%, transparent)` }
              : undefined;
            const tone = a.color ? "text-foreground/80" : "text-calendar-foreground";
            const colorClasses = a.color ? "" : "border-calendar/45 bg-calendar/15";
            if (a.allDay) {
              const top = allDayIndex++ * ALL_DAY_BAND_PX;
              return (
                <div
                  key={`ambient-${a.id}`}
                  data-ambient-id={a.id}
                  className={`pointer-events-none absolute inset-x-0.5 z-0 flex items-center justify-center overflow-hidden rounded-sm border px-1 text-center text-[11px] leading-none ${colorClasses} ${tone}`}
                  style={{ top, height: ALL_DAY_BAND_PX, ...tint }}
                  aria-hidden="true"
                >
                  <span className="truncate font-medium">{tv("calendar.allDay", { title: a.label })}</span>
                </div>
              );
            }
            // Entirely outside the shown hours (e.g. the after-midnight part of a late event): nothing to draw.
            if (a.endMinutes <= dayStartMinutes || a.startMinutes >= dayEndMinutes) return null;
            const rect = clampRideVertical(a.startMinutes, a.endMinutes, dayStartMinutes, dayEndMinutes);
            const laneCount = Math.max(1, a.laneCount ?? 1);
            const laneStyle = laneCount > 1
              ? { insetInlineStart: `calc(${((a.lane ?? 0) / laneCount) * 100}% + 2px)`, width: `calc(${100 / laneCount}% - 4px)` }
              : {};
            return (
              <div
                key={`ambient-${a.id}`}
                data-ambient-id={a.id}
                className={`pointer-events-none absolute ${laneCount > 1 ? "" : "inset-x-0.5"} z-0 flex flex-col items-center justify-center overflow-hidden rounded-sm border px-1 text-center text-xs leading-tight ${colorClasses} ${tone}`}
                style={{ top: rect.top, height: rect.height, ...laneStyle, ...tint }}
                aria-hidden="true"
              >
                <span className="line-clamp-2 text-xs font-medium">{a.label}</span>
                {a.lines?.map((line, index) => (
                  <span key={index} className="line-clamp-1 text-[11px] opacity-80" dir="auto">{line}</span>
                ))}
              </div>
            );
          });
        })()}
        {rangeStart?.carId === car.id && rangeHover != null && rangeHover !== rangeStart.minutes ? (() => {
          const from = Math.min(rangeStart.minutes, rangeHover);
          const to = Math.max(rangeStart.minutes, rangeHover);
          const rect = clampRideVertical(from, to, dayStartMinutes, dayEndMinutes);
          return (
            <div
              data-testid="slot-range-preview"
              className="pointer-events-none absolute inset-x-1 z-20 rounded-sm border-2 border-dashed border-primary bg-primary/15"
              style={{ top: rect.top, height: rect.height }}
              aria-hidden="true"
            >
              <span className="absolute inset-x-0 bottom-0.5 text-center text-[10px] font-semibold text-primary" dir="ltr">
                {formatMinutes(from)}–{formatMinutes(to)}
              </span>
            </div>
          );
        })() : null}
        {rangeStart?.carId === car.id ? (
          <div
            data-testid="slot-range-start"
            className="pointer-events-none absolute inset-x-0 z-30"
            style={{ top: clampRideVertical(rangeStart.minutes, rangeStart.minutes, dayStartMinutes, dayEndMinutes).top }}
          >
            <div className="h-0.5 bg-primary" aria-hidden="true" />
            <div className="mx-0.5 mt-0.5 flex items-start gap-0.5 rounded-sm bg-primary px-1 py-0.5 text-[10px] font-medium leading-tight text-primary-foreground shadow">
              <span className="min-w-0 flex-1 whitespace-normal break-words">
                <span dir="ltr">{tv("slotRange.startHint", { time: formatMinutes(rangeStart.minutes) })}</span>
              </span>
              <button
                type="button"
                className="pointer-events-auto relative shrink-0 before:absolute before:-inset-2 before:content-['']"
                aria-label={he.slotRange.cancel}
                onClick={(event) => { event.stopPropagation(); setRangeStart(null); setRangeHover(null); }}
                data-testid="slot-range-cancel"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </div>
          </div>
        ) : null}
        {blocksFor(car.id).map((b) => {
          const isAway = b.kind === "away";
          const editable = !isAway && !!b.editable && !!onBlockChange;
          const dragging = blockDrag?.blockId === b.id && blockDrag.confirmed ? blockDrag : null;
          const shownStart = dragging && dragging.kind !== "end" ? b.startMinutes + dragging.delta : b.startMinutes;
          const shownEnd = dragging && dragging.kind !== "start" ? b.endMinutes + dragging.delta : b.endMinutes;
          const rect = clampRideVertical(shownStart, shownEnd, dayStartMinutes, dayEndMinutes);
          const handleClass = "absolute inset-x-0 z-30 h-2.5 cursor-ns-resize touch-none border-foreground/30 bg-foreground/15";
          return (
            <div
              key={b.id}
              data-block-kind={b.kind ?? "maintenance"}
              data-block-id={b.id}
              data-block-editable={editable || undefined}
              role={editable ? "button" : undefined}
              tabIndex={editable ? 0 : undefined}
              className={cn(
                // R12B1: an editable band makes no stacking context of its own (z-auto) so its edge handles (z-30) stay above a ride
                // card that overlaps the band; with z-0 a neighbouring ride's own resize handle swallowed the drag.
                "absolute inset-x-1 flex items-start overflow-clip rounded-sm border p-1 text-xs",
                !editable && "z-0",
                // R4U1: an away band is only a hint - it never takes clicks from a ride card on the same car.
                isAway && "pointer-events-none",
                isAway
                  ? "border-muted-foreground/50 bg-[repeating-linear-gradient(45deg,hsl(var(--muted-foreground)/0.25),hsl(var(--muted-foreground)/0.25)_4px,hsl(var(--muted-foreground)/0.08)_4px,hsl(var(--muted-foreground)/0.08)_8px)] text-muted-foreground"
                  : "border-maintenance/60 bg-[repeating-linear-gradient(45deg,hsl(var(--maintenance)/0.35),hsl(var(--maintenance)/0.35)_4px,hsl(var(--maintenance)/0.12)_4px,hsl(var(--maintenance)/0.12)_8px)]",
                editable && "cursor-grab",
                dragging && "z-20 opacity-80 ring-2 ring-primary",
              )}
              style={{ top: rect.top, height: rect.height }}
              title={b.label}
              onPointerDown={editable ? (e) => beginBlockDrag(e, b, "move", e.currentTarget.parentElement) : undefined}
              onClick={editable ? (e) => {
                e.stopPropagation();
                if (suppressBlockClick.current) { suppressBlockClick.current = false; return; }
                onBlockClick?.(b.id);
              } : undefined}
              onKeyDown={editable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onBlockClick?.(b.id); } } : undefined}
            >
              {isAway ? <span className="whitespace-normal break-words">{b.label}</span> : (
                <span className="sticky whitespace-normal break-words font-medium" style={{ top: HEADER_ROW_HEIGHT_PX }}>{he.maintenancePeriod.blockLabel}</span>
              )}
              {editable && !b.clippedStart ? (
                <span
                  data-block-handle="start"
                  className={cn(handleClass, "top-0 border-y")}
                  aria-hidden="true"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => beginBlockDrag(e, b, "start", e.currentTarget.parentElement?.parentElement ?? null)}
                />
              ) : null}
              {editable && !b.clippedEnd ? (
                <span
                  data-block-handle="end"
                  className={cn(handleClass, "bottom-0 border-y")}
                  aria-hidden="true"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => beginBlockDrag(e, b, "end", e.currentTarget.parentElement?.parentElement ?? null)}
                />
              ) : null}
            </div>
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
          const laneCount = Math.max(1, ride.laneCount ?? 1);
          const laned = laneCount > 1;
          const lane = Math.min(Math.max(0, ride.lane ?? 0), laneCount - 1);
          const laneStyle = laned
            ? { insetInlineStart: `calc(${(lane / laneCount) * 100}% + 2px)`, width: `calc(${100 / laneCount}% - 4px)` }
            : {};
          // The member's "visibility aid" — only over a calendar; the dragged block keeps its own drag look.
          // Over a calendar every block — ride or unplaced item alike — gets the same backing and fade (one setting
          // must look the same on both); the block itself then carries only its color tint, borders and text.
          const visibility = ambientBlocks.length > 0 ? itemVisibilityStyle(itemVisibility) : null;
          // A suggestion stays paler than the rest (its own 75%), scaled by the same fade.
          const baseOpacity = ride.kind === "suggestion" ? 0.75 : 1;
          const fade = visibility && !isDragged && (visibility.fade < 1 || baseOpacity < 1) ? { opacity: visibility.fade * baseOpacity } : {};
          const backingOpacity = visibility ? visibility.backing : 0;
          return (
            <Fragment key={ride.id}>
            {/* Owner 2026-10-12: over the member's calendar a ride stays solid (its tint over an opaque backing); only
                unplaced items (`kind`) are see-through. */}
            {backingOpacity > 0 ? (
              <div
                aria-hidden="true"
                className={cn("pointer-events-none absolute rounded-sm bg-background", !laned && "inset-x-1")}
                style={{ top: rect.top, height: rect.height, minHeight: RIDE_MIN_HEIGHT_PX, ...laneStyle, opacity: backingOpacity * (visibility && !isDragged ? visibility.fade : 1) }}
              />
            ) : null}
            <button
              type="button"
              data-ride-id={ride.id}
              data-needs-driver={ride.needsDriver || undefined}
              data-draft={ride.draft || undefined}
              data-merged={ride.merged || undefined}
              data-my-ride={ride.isMine || undefined}
              data-tight-schedule={ride.tightSchedule || undefined}
              data-kind={ride.kind}
              className={cn(
                "absolute flex flex-col overflow-clip rounded-sm border-s-4 text-start text-foreground shadow-sm transition-smooth",
                !laned && "inset-x-1",
                typeColors.bg,
                typeColors.border,
                // My ride: violet fill + ring (the start border keeps the ride-type color); conflict/needs-driver styling below still wins.
                ride.isMine && "bg-mine/25",
                // Conflict/pinned styling always wins over the ride-type tint (kept last so `cn`/tailwind-merge overrides it).
                ride.conflict &&
                  "border-2 border-destructive bg-[repeating-linear-gradient(45deg,hsl(var(--destructive)/0.25),hsl(var(--destructive)/0.25)_6px,hsl(var(--destructive)/0.08)_6px,hsl(var(--destructive)/0.08)_12px)]",
                ride.pendingConsent && "border-2 border-dashed border-maintenance",
                ride.draft && "border-2 border-dashed border-primary bg-primary/10",
                onRideClick && "cursor-pointer",
                dragEnabled && (canDragRide?.(ride) ?? true) && "touch-none",
                ride.shadowed && "opacity-50",
                ride.muted && "border-dotted opacity-70 shadow-none",
                ride.isMine && "shadow-md",
                ride.isMine && !ride.needsDriver && "ring-[3px] ring-mine",
                ride.needsDriver && "border-2 border-dashed border-destructive bg-destructive/10",
                // Owner 2026-10-11 ("my rides" week view): anything that is not a placed ride must never read as one.
                // Unplaced items are see-through (owner 2026-10-12) so the member's calendar shows behind them.
                ride.kind === "suggestion" && "border-2 border-dotted border-muted-foreground/70 bg-background/40 text-muted-foreground opacity-75 shadow-none",
                ride.kind === "proposal" && "border-2 border-amber-500 bg-amber-500/10",
                ride.kind === "waiting" && "border-2 border-dashed border-muted-foreground bg-muted/45",
                ride.kind === "request" && "border-2 border-primary/60 bg-background/40",
                // Over a calendar the backing above provides the fill — no white fill of their own (same alpha as rides).
                visibility && (ride.kind === "suggestion" || ride.kind === "request" || ride.kind === "waiting") && "bg-transparent",
                ride.highlighted && "z-10 scroll-mt-24 ring-4 ring-destructive ring-offset-2",
                isDragged && "opacity-50 ring-2 ring-primary",
              )}
              style={{ top: rect.top, height: rect.height, minHeight: RIDE_MIN_HEIGHT_PX, ...laneStyle, ...fade }}
              title={rect.clampedStart ? `${formatMinutes(ride.startMinutes)}–${formatMinutes(ride.endMinutes)}` : undefined}
              onClick={(e) => {
                e.stopPropagation();
                setRangeStart(null);
                if (suppressClick.current) { suppressClick.current = false; return; }
                openRide(ride.id);
              }}
              onPointerDown={(e) => {
                if (!dragEnabled || !(canDragRide?.(ride) ?? true)) return;
                const rect2 = e.currentTarget.parentElement?.getBoundingClientRect();
                if (!rect2) return;
                beginDrag(e, ride, "move", rect2);
              }}
              aria-label={ride.kind ? `${he.myWeek.kind[ride.kind]} · ${ride.label}` : ride.isMine ? `${he.siddur.myRide} · ${ride.label}` : ride.draft ? `${he.boardDrafts.tag} · ${ride.label}` : ride.label}
            >
              {/* Sliding label (owner, 2026-09-14): everything readable in the block — badges, clamped-start
                  hint and the label itself — sits in one `sticky` wrapper offset by the header row, so on a
                  long ride (06:00–18:00) the text follows the reader down the block and stops at the block's
                  own bottom edge (the button is the containing block). Works because the grid's scroll
                  viewport is the nearest scroll container: the button clips with `overflow-clip`, which,
                  unlike `overflow-hidden`, does not create a new scroll container. Resize handles stay
                  absolutely positioned outside the wrapper. */}
              <div className="sticky z-[1] flex min-h-0 w-full flex-col" style={{ top: HEADER_ROW_HEIGHT_PX }}>
              {ride.guests?.length ? <GuestChips guests={ride.guests} passClick={!!ride.draft} enabled={dragEnabled && !!onGuestDrop} resolveTarget={guestTargetAt} onHover={onGuestHover} onDrop={onGuestDrop} /> : null}
              {(ride.kind || ride.isMine || ride.needsDriver || ride.tightSchedule || ride.chainBrokenWarning || ride.driverOverlapWarning || ride.handoverLines?.length || ride.draft || ride.merged || ride.connected || ride.luggage) ? <span className="flex w-full flex-wrap gap-1 px-1.5 pt-1 text-[10px] leading-tight">
                {ride.kind ? (
                  <span
                    className={cn("rounded-sm px-1 font-bold uppercase", ride.kind === "suggestion" ? "border border-dotted border-muted-foreground/70" : ride.kind === "proposal" ? "bg-amber-500 text-white" : "bg-foreground/10")}
                    data-testid="kind-tag"
                  >
                    {he.myWeek.kind[ride.kind]}
                  </span>
                ) : null}
                {ride.draft ? <span className="rounded-sm bg-primary px-1 font-semibold text-primary-foreground" data-testid="draft-tag">{he.boardDrafts.tag}</span> : null}
                {ride.merged ? <span className="rounded-sm bg-foreground/10 px-1 font-medium" data-testid="merged-marker">{he.mergedRide.marker}</span> : null}
                {ride.luggage ? <span className="rounded-sm bg-foreground/10 px-1 font-medium" data-testid="luggage-marker" data-waived={ride.luggageWaived ? "true" : undefined}>{ride.luggageWaived ? he.smallTrunk.waivedLabel : he.request.luggageChip}</span> : null}
                {ride.connected ? <span className="rounded-sm bg-foreground/10 px-1 font-medium" data-testid="connected-marker">{he.connectedPair.marker}</span> : null}
                {ride.isMine ? <span className={cn("flex items-center gap-1 font-bold", ride.needsDriver ? "text-destructive" : "text-foreground")}><Star className="size-3 shrink-0 fill-current" aria-hidden="true" />{he.siddur.myRide}</span> : null}
                {ride.needsDriver ? <span className="flex items-center gap-1 font-semibold text-destructive"><UserRoundX className="size-3 shrink-0" aria-hidden="true" />{he.boardCoordination.needsDriver}</span> : null}
                {ride.tightSchedule ? <span className="flex items-center gap-1 text-amber-700" title={he.boardCoordination.tightHelp}><Clock3 className="size-3 shrink-0" aria-hidden="true" />{he.boardCoordination.tight}</span> : null}
                {ride.driverOverlapWarning ? <span className="flex items-center gap-1 font-medium text-amber-700" title={ride.driverOverlapWarning}>{ride.driverOverlapWarning}</span> : null}
                {ride.chainBrokenWarning ? <span className="flex items-center gap-1 font-medium text-amber-700" title={ride.chainBrokenWarning}><CarFront className="size-3 shrink-0" aria-hidden="true" />{ride.chainBrokenWarning}</span> : null}
                {ride.handoverLines?.map((line) => <span key={line} className="flex items-start gap-1 font-medium text-amber-700" title={line} data-testid="handover-line"><span aria-label={he.carHandover.alertLabel} role="img" className="font-bold">!</span><span className="line-clamp-2 min-w-0">{line}</span></span>)}
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
                  className={cn("absolute inset-x-0 top-0 z-20 cursor-ns-resize touch-none border-y border-foreground/20 bg-foreground/10", ride.endMinutes - ride.startMinutes <= SHORT_RIDE_MINUTES ? "h-1" : "h-2.5")}
                  aria-hidden="true"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => {
                    // The column, not `parentElement.parentElement`: this handle sits inside the sticky label wrapper, so that
                    // was the ride block — every pixel counted ~9× (owner 2026-10-11, "dragging from above jumps").
                    const rect2 = e.currentTarget.closest<HTMLElement>(`[${CAR_COLUMN_ATTR}]`)?.getBoundingClientRect();
                    if (!rect2) return;
                    beginDrag(e, ride, "resize-start", rect2);
                  }}
                />
              ) : null}
              {renderRide ? renderRide(ride) : defaultRenderRide(ride)}
              </div>
              {resizeEnabled && (canDragRide?.(ride) ?? true) && (canResizeRide?.(ride) ?? true) ? (
                <span
                  className={cn("absolute inset-x-0 bottom-0 z-20 cursor-ns-resize touch-none border-y border-foreground/20 bg-foreground/10", ride.endMinutes - ride.startMinutes <= SHORT_RIDE_MINUTES ? "h-1" : "h-2.5")}
                  aria-hidden="true"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => {
                    const rect2 = e.currentTarget.closest<HTMLElement>(`[${CAR_COLUMN_ATTR}]`)?.getBoundingClientRect();
                    if (!rect2) return;
                    beginDrag(e, ride, "resize-end", rect2);
                  }}
                />
              ) : null}
            </button>
            </Fragment>
          );
        })}
      </div>
    );
  }

  /** Corner + car headers + discussion header, one render for both placements (in the grid below `lg`, pinned above the box on `lg`). */
  const headerCells = (
      <>
        <div className="sticky start-0 top-0 z-30 border-b border-e bg-muted shadow-[0_2px_6px_-2px_hsl(var(--foreground)/0.12)]" style={{ gridColumn: 1, gridRow: 1 }} />
        {allCars.map((car, i) => {
          const swappable = canSwapCars && !!onCarSwap && car.group !== "phantom";
          const hasCarMenu = car.group !== "phantom" && (swappable || !!enableCarReport || !!onOpenCarPage);
          const isCarDragSource = swappable && carDrag?.confirmed && carDrag.carId === car.id;
          const isCarDropHover = swappable && carDragHoverId === car.id && carDrag?.carId !== car.id;
          return (
          <div
            key={`h-${car.id}`}
            data-car-header-id={car.id}
            className={cn(
              "sticky top-0 z-20 flex flex-col justify-center gap-0.5 overflow-hidden border-b border-e bg-muted px-2 py-1 text-sm shadow-[0_2px_6px_-2px_hsl(var(--foreground)/0.12)]",
              car.group === "temporary" && "bg-background bg-gradient-to-b from-booked/10 to-booked/10",
              // Owner 2026-10-09: bold alone was not obvious on a phone — the header of a car I ride in that day is tinted violet.
              (myCarIds.has(car.id) || car.today) && "bg-mine/25 bg-none border-b-4 border-b-mine",
              i === sharedCars.length && temporaryCars.length > 0 && "border-s-2 border-s-border",
              swappable && "touch-none",
              isCarDragSource && "opacity-40",
              isCarDropHover && "bg-primary/10 ring-2 ring-inset ring-primary",
              car.unpublished && "text-muted-foreground",
            )}
            style={{ gridColumn: i + 2, gridRow: 1, scrollSnapAlign: "start" }}
            onPointerDown={swappable ? (e) => carPointerDownRef.current(car.id, e) : undefined}
          >
            <span className={cn("flex min-w-0 items-center justify-center gap-1 text-center text-sm md:text-base leading-tight", myCarIds.has(car.id) || car.today ? "font-bold" : "font-medium")} data-testid="week-grid-car-name" data-my-car={myCarIds.has(car.id) || undefined} data-today={car.today || undefined} data-unpublished={car.unpublished || undefined}>
              {renderCarName ? renderCarName(car) : hasCarMenu ? (
                <DropdownMenu open={menuCarId === car.id} onOpenChange={(o) => { if (!o) setMenuCarId(null); }}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex min-h-8 min-w-0 max-w-full items-center gap-0.5 rounded px-0.5 text-center hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={tv("carSwap.carMenuLabel", { car: car.name })}
                      data-testid="week-grid-car-menu-trigger"
                      // Radix opens on pointerdown; ours opens on click so a touch long-press (swap drag) never opens it.
                      // Mouse: the click path still opens it; the header's own pointerdown (drag start) is left to bubble.
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (suppressCarClickRef.current) return;
                        setMenuCarId((cur) => (cur === car.id ? null : car.id));
                      }}
                    >
                      <span className="min-w-0 whitespace-normal break-words line-clamp-2" title={car.name}>{car.name}</span>
                      <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {swappable ? allCars.filter((other) => other.id !== car.id && other.group !== "phantom").map((other) => (
                      <DropdownMenuItem key={other.id} onSelect={() => onCarSwap?.(car.id, other.id)}>
                        {tv("carSwap.swapWithCar", { car: other.name })}
                      </DropdownMenuItem>
                    )) : null}
                    {swappable && (enableCarReport || onOpenCarPage) ? <DropdownMenuSeparator /> : null}
                    {enableCarReport ? (
                      <DropdownMenuItem data-testid="car-name-report-menu-item" onSelect={() => setReportCarId(car.id)}>
                        {he.carSwap.carReportItem}
                      </DropdownMenuItem>
                    ) : null}
                    {onOpenCarPage ? (
                      <DropdownMenuItem data-testid="car-page-menu-item" onSelect={() => onOpenCarPage(car.id)}>
                        {he.carSwap.carPageItem}
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <>
                  <CarFront className="size-3.5 shrink-0 text-primary md:size-4" aria-hidden="true" />
                  <span className="min-w-0 whitespace-normal break-words line-clamp-2" title={car.name}>{car.name}</span>
                </>
              )}
            </span>
            {car.locationBadge ? <span className="truncate text-center text-xs text-muted-foreground">{car.locationBadge}</span> : null}
            {car.baseBadge ? <span className="truncate text-center text-[10px] text-muted-foreground">{car.baseBadge}</span> : null}
            {car.weekEndAwayWarning ? <span className="truncate text-center text-[10px] font-medium text-amber-700">{car.weekEndAwayWarning}</span> : null}
            {car.unpublished ? <span className="truncate text-center text-[10px] font-medium">{he.publicationFlow.watermark}</span> : null}
            {car.group === "temporary" ? <span className="truncate text-center text-[10px] text-booked">{he.car.type.temporary}</span> : null}
          </div>
          );
        })}
        {reportCarId ? (() => {
          const reportCar = allCars.find((c) => c.id === reportCarId);
          return reportCar ? <CarReportDialog carId={reportCar.id} carName={reportCar.name} open onOpenChange={(o) => { if (!o) setReportCarId(null); }} /> : null;
        })() : null}
        {hasDiscussionLane ? (
          <div
            className="sticky top-0 z-20 flex items-center justify-center border-b border-s-2 border-s-border bg-background bg-gradient-to-b from-maintenance/10 to-maintenance/10 px-2 py-1 text-sm shadow-[0_2px_6px_-2px_hsl(var(--foreground)/0.12)]"
            style={{ gridColumn: discussionColIndex, gridRow: 1 }}
          >
            <span className="font-medium">{he.waitlist.laneTitle}</span>
          </div>
        ) : null}
      </>
  );

  const peekRide = notesPeek ? rides.find((r) => r.id === notesPeek.rideId) : undefined;

  return (
    <div className="min-w-0">
    {notesPeek && peekRide ? (
      <Popover open onOpenChange={(open) => { if (!open) setNotesPeek(null); }}>
        <PopoverAnchor virtualRef={{ current: notesPeek.el }} />
        <PopoverContent
          ref={notesPeekRef}
          // Focus stays on the ride: moving it into the popup could scroll the page, and a scroll closes the popup.
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="flex max-h-[60dvh] w-72 max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-y-auto p-3 text-sm"
          // The second tap on the same block must reach it (it opens the ride), not just close the popup.
          onInteractOutside={(e) => { if (e.target instanceof Node && notesPeek.el.contains(e.target)) e.preventDefault(); }}
          data-testid="ride-notes-peek"
        >
          <p className="font-medium">{peekRide.label}</p>
          <p className="text-xs text-muted-foreground" dir="ltr">{formatMinutes(peekRide.startMinutes)}–{formatMinutes(peekRide.endMinutes)}</p>
          {peekRide.passengerSummary ? <p className="whitespace-pre-wrap break-words">{peekRide.passengerSummary}</p> : null}
          {peekRide.description ? <p className="whitespace-pre-wrap break-words">{peekRide.description}</p> : null}
          {peekRide.coordinatorNotes ? <p className="whitespace-pre-wrap break-words">{he.field.notes}: {peekRide.coordinatorNotes}</p> : null}
          {onRideClick ? (
            <Button type="button" size="sm" variant="outline" className="self-start" data-testid="ride-peek-open" onClick={() => { setNotesPeek(null); onRideClick(peekRide.id); }}>
              {he.screen.ride.detail}
            </Button>
          ) : null}
        </PopoverContent>
      </Popover>
    ) : null}
    {pageScroll ? (
      <div
        ref={headerRef}
        data-week-grid-header
        // Below `md` the app shell's own sticky `h-14` header sits above (top-14); from `md` it is hidden.
        className="sticky top-14 z-30 md:top-0 overflow-hidden rounded-t-md border border-b-0 bg-muted"
      >
        <ScaledGrid zoom={zoom} gridTemplateColumns={gridTemplateColumns} gridTemplateRows={`minmax(${HEADER_ROW_HEIGHT_PX}px, auto)`} minWidth={gridMinWidth}>
          {headerCells}
        </ScaledGrid>
      </div>
    ) : null}
    <div
      ref={setScrollViewport}
      className={cn("min-w-0 rounded-md border shadow-card", drafting && "bg-card", pageScroll ? "overflow-auto overflow-y-hidden rounded-t-none" : "max-h-[70dvh] overflow-auto", (dragActive || dragEnabled) && "select-none")}
      onScroll={pageScroll ? (e) => { if (headerRef.current) headerRef.current.scrollLeft = e.currentTarget.scrollLeft; } : undefined}
      style={{ touchAction: "pan-x pan-y", scrollSnapType: "x proximity", scrollPaddingInlineStart: HOUR_COL_WIDTH_PX * zoom }}
      data-week-grid-scroll-viewport
    >
      <ScaledGrid zoom={zoom} gridTemplateColumns={gridTemplateColumns} gridTemplateRows={gridTemplateRows} minWidth={gridMinWidth}>
        {pageScroll ? null : headerCells}
        {hours.map((h, i) => {
          const quarterHere = nowQuarterMinutes != null && Math.floor(nowQuarterMinutes / 60) === h ? nowQuarterMinutes : null;
          return (
            <div
              key={h}
              className="sticky start-0 z-10 flex items-start justify-end border-b border-e bg-muted px-px pt-0.5 tabular-nums text-xs font-medium text-muted-foreground shadow-[2px_0_6px_-2px_hsl(var(--foreground)/0.12)]"
              style={{ gridColumn: 1, gridRow: i + 2 }}
            >
              {/* On the hour the band covers the label's place and carries the same time: one label, not two on top of each other. */}
              {quarterHere != null && quarterHere % 60 === 0 ? null : <span dir="ltr">{formatMinutes(h * 60)}</span>}
              {quarterHere != null ? (
                <span
                  className="absolute inset-x-0 flex items-center justify-center border-y border-mine bg-mine/25 text-[10px] font-bold text-foreground"
                  style={{ top: `${((quarterHere % 60) / 60) * 100}%`, height: "25%" }}
                  data-testid="week-grid-now-quarter"
                  dir="ltr"
                >
                  {formatMinutes(quarterHere)}
                </span>
              ) : null}
            </div>
          );
        })}
        {allCars.map((car, i) => (
          Column({ car, colIndex: i })
        ))}
        {watermark ? (
          <div className="pointer-events-none relative" style={{ gridColumn: "2 / -1", gridRow: `2 / span ${hours.length}` }}>
            <DraftWatermark />
          </div>
        ) : null}
        {hasDiscussionLane ? (
          <div
            className="relative border-s-2 border-s-border bg-maintenance/5"
            style={{ gridColumn: discussionColIndex, gridRow: `2 / span ${hours.length}` }}
          >
            {hours.map((h, hi) => {
              const bandRect = clampRideVertical(h * 60, (h + 1) * 60, dayStartMinutes, dayEndMinutes);
              return (
                <div
                  key={`discussion-band-${h}`}
                  className={cn("absolute inset-x-0", hi % 2 === 1 && "bg-muted/40")}
                  style={{ top: bandRect.top, height: bandRect.height }}
                  aria-hidden="true"
                />
              );
            })}
            {hours.map((h) => (
              <div
                key={`discussion-line-${h}`}
                className="absolute inset-x-0 border-b border-border"
                style={{ top: clampRideVertical(h * 60, h * 60, dayStartMinutes, dayEndMinutes).top }}
                aria-hidden="true"
              />
            ))}
            {discussionBlocks.map((block) => {
              const rect = clampRideVertical(block.startMinutes, block.endMinutes, dayStartMinutes, dayEndMinutes);
              return (
                <button
                  key={block.id}
                  type="button"
                  className="absolute inset-x-1 overflow-hidden rounded-sm border-2 border-dashed border-amber-500 bg-amber-500/10 p-1 text-start text-xs font-medium text-amber-900 shadow-sm"
                  style={{ top: rect.top, height: rect.height, minHeight: RIDE_MIN_HEIGHT_PX }}
                  onClick={() => onDiscussionClick?.(block.id)}
                >
                  <span className="line-clamp-3 whitespace-normal break-words">{block.label}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </ScaledGrid>
      {carDrag?.confirmed ? (
        <div
          data-car-swap-drag-preview
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded-md border bg-popover px-3 py-1.5 text-xs font-medium opacity-80 shadow-lg"
          style={{ left: carDrag.clientX, top: carDrag.clientY }}
        >
          {allCars.find((c) => c.id === carDrag.carId)?.name ?? ""}
        </div>
      ) : null}
    </div>
    </div>
  );
}
