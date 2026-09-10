/**
 * Pure two-finger pinch-to-zoom math for `WeekGrid`'s CSS `zoom` (UX_FLOWS.md
 * member siddur "pinch to zoom" — mobile phones can shrink/grow the table
 * without the ± buttons). `startZoom`/`startDist` are captured once, the
 * instant a second finger touches down; every later `touchmove` recomputes
 * the live zoom from those same anchors (never from the previous frame's
 * result) so drift never accumulates across a long gesture.
 *
 * No React/DOM here — `WeekGrid.tsx` wires this to native `touchstart`/
 * `touchmove` listeners on its scroll container.
 */
export const PINCH_ZOOM_MIN = 0.5;
export const PINCH_ZOOM_MAX = 1.5;
export const PINCH_ZOOM_STEP = 0.05;

/**
 * The next zoom level for a pinch gesture, clamped to
 * `[PINCH_ZOOM_MIN, PINCH_ZOOM_MAX]` and rounded to the nearest
 * `PINCH_ZOOM_STEP` (matching the ± buttons' own 0.05 increments,
 * `TableViewControls.tsx`). A degenerate `startDist` (0 or negative — the
 * second touch hasn't produced a real distance yet) returns `startZoom`
 * unchanged rather than dividing by zero.
 */
export function nextZoom(startZoom: number, startDist: number, dist: number): number {
  if (startDist <= 0) return startZoom;
  const raw = startZoom * (dist / startDist);
  const clamped = Math.min(PINCH_ZOOM_MAX, Math.max(PINCH_ZOOM_MIN, raw));
  const stepped = Math.round(clamped / PINCH_ZOOM_STEP) * PINCH_ZOOM_STEP;
  // Undo binary floating-point noise from the division/multiplication above
  // (e.g. 1.0500000000000001) so callers can compare/display the result directly.
  return Math.round(stepped * 100) / 100;
}
