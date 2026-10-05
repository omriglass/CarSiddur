/** Pixels from a scroller edge inside which a drag starts auto-scrolling. */
export const AUTO_SCROLL_ZONE_PX = 48;
/** Maximum scroll speed in pixels per animation frame. */
export const AUTO_SCROLL_MAX_STEP_PX = 18;

/**
 * Scroll step for one axis: negative towards `start`, positive towards `end`, 0 away from both
 * edges. Speed grows linearly as the pointer nears (or passes) the edge.
 */
export function edgeScrollStep(pos: number, start: number, end: number, zone = AUTO_SCROLL_ZONE_PX, max = AUTO_SCROLL_MAX_STEP_PX): number {
  if (end - start < zone * 2) return 0;
  if (pos < start + zone) return -Math.round(max * Math.min(1, (start + zone - pos) / zone));
  if (pos > end - zone) return Math.round(max * Math.min(1, (pos - (end - zone)) / zone));
  return 0;
}
