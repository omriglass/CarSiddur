// REQ §13.154 (owner 2026-10-26): zooming into the month (− / + and two-finger pinch, like the board), so the calendar
// labels become readable; 100% is the whole month on screen. Remembered on this device.
export const PLANNING_ZOOM_MIN = 1;
export const PLANNING_ZOOM_MAX = 2.5;
const BUTTON_STEP = 0.25;
const PINCH_STEP = 0.05;
const STORAGE_KEY = "planning.zoom.v1";

function clamp(zoom: number): number {
  return Math.min(PLANNING_ZOOM_MAX, Math.max(PLANNING_ZOOM_MIN, zoom));
}

export function planningZoomIn(zoom: number): number {
  return clamp(Math.round((zoom + BUTTON_STEP) * 100) / 100);
}

export function planningZoomOut(zoom: number): number {
  return clamp(Math.round((zoom - BUTTON_STEP) * 100) / 100);
}

/** The zoom for a pinch that started at `startZoom` with the fingers `startDist` apart and is now `dist` apart. */
export function planningPinchZoom(startZoom: number, startDist: number, dist: number): number {
  if (startDist <= 0) return startZoom;
  const stepped = Math.round(clamp(startZoom * (dist / startDist)) / PINCH_STEP) * PINCH_STEP;
  return Math.round(stepped * 100) / 100;
}

export function readPlanningZoom(): number {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? clamp(value) : PLANNING_ZOOM_MIN;
  } catch {
    return PLANNING_ZOOM_MIN;
  }
}

export function writePlanningZoom(zoom: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(zoom));
  } catch {
    // private window / blocked storage: the zoom just is not remembered
  }
}
