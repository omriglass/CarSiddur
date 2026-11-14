/**
 * The ride summary popup's anchor (WeekGrid `notesPeek`). Anchored to a whole block, a ride taller than the free room
 * on screen (a full-day ride at 06:00–23:59) left no side with space, and the popup was drawn above the top of the
 * screen, out of reach. The anchor is the block's visible part; a tall one shrinks to a strip at its visible top, so
 * the popup opens just below it, on screen.
 */
export const PEEK_TALL_ANCHOR_PX = 160;
export const PEEK_STRIP_PX = 40;

export function peekAnchorBox(rect: { top: number; bottom: number }, viewportHeight: number): { top: number; bottom: number } {
  const top = Math.min(Math.max(rect.top, 0), viewportHeight);
  const bottom = Math.max(Math.min(rect.bottom, viewportHeight), top);
  return bottom - top > PEEK_TALL_ANCHOR_PX ? { top, bottom: top + PEEK_STRIP_PX } : { top, bottom };
}

/** A Radix virtual anchor for `el` (re-measured on every layout, so scrolling keeps it right). */
export function peekAnchorOf(el: HTMLElement): { getBoundingClientRect: () => DOMRect } {
  return {
    getBoundingClientRect: () => {
      const rect = el.getBoundingClientRect();
      const box = peekAnchorBox(rect, window.innerHeight);
      return new DOMRect(rect.left, box.top, rect.width, box.bottom - box.top);
    },
  };
}
