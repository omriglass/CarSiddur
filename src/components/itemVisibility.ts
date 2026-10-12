// "Visibility aid" over the member's calendar (owner 2026-10-12): one 0–100 scale, 50 = the normal look.
//   below 50 → every ride / item block fades, down to 20% opacity at 0, so the calendar shows through them;
//   above 50 → the see-through items (request, waiting list, suggestion, proposal) get an opaque backing that grows
//              to fully solid at 100 (rides are already solid over a calendar).
// Pure; `WeekGrid` applies it only while calendar blocks are drawn.

export const ITEM_VISIBILITY_DEFAULT = 50;
const MIN_FADE_OPACITY = 0.2;

export interface ItemVisibilityStyle {
  /** Opacity for every item block and its backing; `undefined` = untouched. */
  fade: number | undefined;
  /** Opacity (0–1) of an opaque backing behind see-through items; 0 = none. */
  backing: number;
}

export function clampItemVisibility(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : ITEM_VISIBILITY_DEFAULT;
}

export function itemVisibilityStyle(value: number | undefined): ItemVisibilityStyle {
  const v = clampItemVisibility(value ?? ITEM_VISIBILITY_DEFAULT);
  if (v < ITEM_VISIBILITY_DEFAULT) {
    return { fade: MIN_FADE_OPACITY + (v / ITEM_VISIBILITY_DEFAULT) * (1 - MIN_FADE_OPACITY), backing: 0 };
  }
  return { fade: undefined, backing: (v - ITEM_VISIBILITY_DEFAULT) / (100 - ITEM_VISIBILITY_DEFAULT) };
}
