// "Visibility aid" over the member's calendar (owner 2026-10-12): one 0–100 scale, 50 = the normal look, applied
// IDENTICALLY to rides and to unplaced items (request, waiting list, suggestion, proposal) so one setting looks right on
// both (owner: "rides and requests should have similar alpha values").
//   backing — an opaque backing behind every block (its own color tint stays on top): 0 at 0, 0.6 at the middle,
//             fully solid at 100. Over a calendar the blocks have no other fill of their own.
//   fade    — below the middle the whole block (text and borders too) also fades, to 40% at 0.
// Pure; `WeekGrid` applies it only while calendar blocks are drawn.

export const ITEM_VISIBILITY_DEFAULT = 50;
const MIDDLE_BACKING = 0.6;
const MIN_FADE_OPACITY = 0.4;

export interface ItemVisibilityStyle {
  /** Whole-block opacity (text and borders too); 1 = untouched. */
  fade: number;
  /** Opacity (0–1) of the opaque backing behind every block. */
  backing: number;
}

export function clampItemVisibility(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : ITEM_VISIBILITY_DEFAULT;
}

export function itemVisibilityStyle(value: number | undefined): ItemVisibilityStyle {
  const v = clampItemVisibility(value ?? ITEM_VISIBILITY_DEFAULT);
  if (v <= ITEM_VISIBILITY_DEFAULT) {
    const t = v / ITEM_VISIBILITY_DEFAULT;
    return { fade: MIN_FADE_OPACITY + t * (1 - MIN_FADE_OPACITY), backing: t * MIDDLE_BACKING };
  }
  const t = (v - ITEM_VISIBILITY_DEFAULT) / (100 - ITEM_VISIBILITY_DEFAULT);
  return { fade: 1, backing: MIDDLE_BACKING + t * (1 - MIDDLE_BACKING) };
}
