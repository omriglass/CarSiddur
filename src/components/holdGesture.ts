/**
 * Long-press-to-drag for the member's siddur and "my rides" while edit mode is off (owner 2026-10-30): a drag starts
 * only after the pointer is held still for `HOLD_TO_DRAG_MS`; moving earlier is a scroll (touch) or nothing (mouse).
 * Layout-only, like `WeekGrid`: it reports what happened through callbacks and never decides what a drag means.
 */

export const HOLD_TO_DRAG_MS = 500;
/** Movement allowed while holding (a finger is never perfectly still). */
const HOLD_MOVE_TOLERANCE_PX = 8;
/** A touch that moves before this is a flick-scroll, not an attempt to drag. */
const TOUCH_ATTEMPT_MIN_MS = 150;

export interface HoldStart {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
}

export function holdStartOf(event: { pointerId: number; pointerType: string; clientX: number; clientY: number }): HoldStart {
  return { pointerId: event.pointerId, pointerType: event.pointerType, clientX: event.clientX, clientY: event.clientY };
}

/**
 * Whether moving `elapsedMs` after the press looks like an attempt to drag (shown as a hint), not a scroll: always
 * for a mouse or pen; for a finger only after a short press.
 */
export function isDragAttempt(pointerType: string, elapsedMs: number): boolean {
  return pointerType !== "touch" || elapsedMs >= TOUCH_ATTEMPT_MIN_MS;
}

/**
 * Watches one press. `onArmed` (omit for something that cannot be dragged at all) fires after the hold, with the
 * press still down — the caller starts its drag from `start` then. Moving past the tolerance first ends the watch,
 * calls `onMoved`, and `onAttempt` when it looked like an attempt. Returns a function that stops watching.
 */
export function watchHold(start: HoldStart, handlers: { onArmed?: () => void; onAttempt?: () => void; onMoved?: () => void; holdMs?: number }): () => void {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onEnd);
    window.removeEventListener("pointercancel", onEnd);
  }
  function onMove(event: PointerEvent) {
    if (event.pointerId !== start.pointerId) return;
    if (Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < HOLD_MOVE_TOLERANCE_PX) return;
    stop();
    handlers.onMoved?.();
    if (isDragAttempt(start.pointerType, Date.now() - startedAt)) handlers.onAttempt?.();
  }
  function onEnd(event: PointerEvent) {
    if (event.pointerId === start.pointerId) stop();
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onEnd);
  window.addEventListener("pointercancel", onEnd);
  if (handlers.onArmed) {
    const armed = handlers.onArmed;
    timer = setTimeout(() => {
      stop();
      navigator.vibrate?.(20);
      armed();
    }, handlers.holdMs ?? HOLD_TO_DRAG_MS);
  }
  return stop;
}

/**
 * After a hold on touch the finger's next move would scroll the page (the blocks are not `touch-none` while edit mode
 * is off); one window listener cancels those moves while a held drag is on.
 */
let touchScrollLocked = false;
let touchListenerInstalled = false;
export function setTouchScrollLocked(locked: boolean) {
  touchScrollLocked = locked;
  if (locked && !touchListenerInstalled && typeof window !== "undefined") {
    touchListenerInstalled = true;
    window.addEventListener("touchmove", (event) => { if (touchScrollLocked && event.cancelable) event.preventDefault(); }, { passive: false });
  }
}
