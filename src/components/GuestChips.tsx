// REQ §13.94 (G10): the added people of a merged ride block as small draggable chips. A pointer
// drag on a chip (stopPropagation, so the block itself does not move) is a "guest drag": the
// caller resolves the target under the pointer (`resolveTarget`) - the unmet list / a phantom lane
// (unmerge) or a car column / another ride (unmerge, then the normal placement path) - and reacts to
// `onHover` (live preview) / `onDrop`. Same gesture split as `UnmetList`: a mouse confirms after a
// few pixels, a touch needs a long press so the grid still scrolls.
import { useRef, useState } from "react";

import { he } from "@/i18n/he";

export interface WeekGridGuest {
  requestId: string;
  /** The (base) ride the person is on. */
  rideId: string;
  name: string;
}

export type GuestDropTarget =
  | { kind: "unmet" }
  | { kind: "car"; carId: string; minutes: number; hostRideId?: string };

const MOUSE_CONFIRM_PX = 6;
const TOUCH_CANCEL_PX = 10;
const LONG_PRESS_MS = 350;

interface GuestDrag {
  guest: WeekGridGuest;
  pointerId: number;
  pointerType: string;
  x: number;
  y: number;
  confirmed: boolean;
}

export interface GuestChipsProps {
  guests: readonly WeekGridGuest[];
  enabled: boolean;
  resolveTarget: (clientX: number, clientY: number) => GuestDropTarget | null;
  onHover?: (guest: WeekGridGuest, target: GuestDropTarget | null) => void;
  onDrop?: (guest: WeekGridGuest, target: GuestDropTarget) => void;
}

export function GuestChips({ guests, enabled, resolveTarget, onHover, onDrop }: GuestChipsProps) {
  const [drag, setDrag] = useState<GuestDrag | null>(null);
  const dragRef = useRef<GuestDrag | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function detach() {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
  }

  function finish(commit: boolean) {
    const done = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    detach();
    if (!done?.confirmed) return;
    onHover?.(done.guest, null);
    if (!commit) return;
    const target = resolveTarget(done.x, done.y);
    if (target) onDrop?.(done.guest, target);
  }

  function move(event: PointerEvent) {
    const current = dragRef.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const moved = Math.max(Math.abs(event.clientX - current.x), Math.abs(event.clientY - current.y));
    if (!current.confirmed) {
      if (current.pointerType === "touch") {
        if (moved >= TOUCH_CANCEL_PX) { dragRef.current = null; setDrag(null); detach(); }
        return;
      }
      if (moved < MOUSE_CONFIRM_PX) return;
    }
    const next = { ...current, confirmed: true, x: event.clientX, y: event.clientY };
    dragRef.current = next;
    setDrag(next);
    onHover?.(next.guest, resolveTarget(event.clientX, event.clientY));
    event.preventDefault();
  }
  function up(event: PointerEvent) { if (dragRef.current?.pointerId === event.pointerId) finish(true); }
  function cancel(event: PointerEvent) { if (dragRef.current?.pointerId === event.pointerId) finish(false); }

  function begin(guest: WeekGridGuest, event: React.PointerEvent<HTMLElement>) {
    event.stopPropagation(); // the block itself must not start moving
    if (!enabled) return;
    const state: GuestDrag = { guest, pointerId: event.pointerId, pointerType: event.pointerType, x: event.clientX, y: event.clientY, confirmed: false };
    dragRef.current = state;
    setDrag(state);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    if (event.pointerType === "touch") {
      timer.current = setTimeout(() => {
        if (dragRef.current?.pointerId === event.pointerId) { dragRef.current = { ...dragRef.current, confirmed: true }; setDrag(dragRef.current); }
      }, LONG_PRESS_MS);
    } else event.preventDefault();
  }

  if (!guests.length) return null;
  return (
    <span className="flex w-full flex-wrap gap-1 px-1.5 pt-1" data-testid="guest-chips">
      {guests.map((guest) => (
        <span
          key={guest.requestId}
          role="button"
          tabIndex={-1}
          data-guest-chip
          data-request-id={guest.requestId}
          aria-label={he.mergedRide.dragChip}
          className={`inline-flex min-h-6 touch-none items-center rounded-full border bg-background/80 px-2 text-[10px] leading-tight ${enabled ? "cursor-grab active:cursor-grabbing" : ""} ${drag?.confirmed && drag.guest.requestId === guest.requestId ? "opacity-50" : ""}`}
          onPointerDown={(event) => begin(guest, event)}
          onClick={(event) => event.stopPropagation()}
        >
          {guest.name}
        </span>
      ))}
      {drag?.confirmed ? (
        <span className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded-md border bg-popover px-3 py-1.5 text-xs opacity-50 shadow-lg" style={{ left: drag.x, top: drag.y }}>
          {drag.guest.name}
        </span>
      ) : null}
    </span>
  );
}
