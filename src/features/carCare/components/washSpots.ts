// Pure geometry of the wipe-to-confirm wash (REQ §13.121 b): mud spots on the car body and how
// rubbing over them cleans them. Coordinates are the car SVG's own viewBox units.

/** viewBox of the wash car drawing. */
export const WASH_W = 320;
export const WASH_H = 170;

/** Sponge radius: a spot is rubbed while the sponge's path passes within `spot.r + WASH_BRUSH`. */
export const WASH_BRUSH = 12;
/** Path length (viewBox units) of rubbing over one spot that cleans it completely — about two swipes. */
export const WASH_RUB_DISTANCE = 70;
/** A tap without movement still rubs a little. */
export const WASH_TAP_RUB = 6;

export interface MudSpot {
  x: number;
  y: number;
  r: number;
}

/** Fixed mud spots, all on the car body or windows (the drawing clips them to the car silhouette). */
export const WASH_SPOTS: readonly MudSpot[] = [
  { x: 48, y: 108, r: 12 },
  { x: 104, y: 112, r: 11 },
  { x: 132, y: 70, r: 10 },
  { x: 150, y: 102, r: 13 },
  { x: 200, y: 68, r: 10 },
  { x: 206, y: 108, r: 12 },
  { x: 262, y: 100, r: 11 },
  { x: 286, y: 116, r: 8 },
];

export interface Point {
  x: number;
  y: number;
}

/** Shortest distance from `p` to the segment `a`–`b`. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * New dirt levels (1 = dirty, 0 = clean) after the sponge moved from `from` to `to`: every spot the
 * stroke passes over loses dirt in proportion to the stroke length (at least `WASH_TAP_RUB`, at most the
 * spot's own width — a fast swipe across the whole car needs a second pass).
 */
export function rubSpots(levels: readonly number[], spots: readonly MudSpot[], from: Point, to: Point): number[] {
  const stroke = Math.max(WASH_TAP_RUB, Math.hypot(to.x - from.x, to.y - from.y));
  return levels.map((level, i) => {
    const spot = spots[i];
    if (!spot || level <= 0) return level;
    const reach = spot.r + WASH_BRUSH;
    if (distanceToSegment(spot, from, to) > reach) return level;
    // Only the part of the stroke over the spot rubs it: one fast swipe across the car is not a wash.
    const next = level - Math.min(stroke, 2 * reach) / WASH_RUB_DISTANCE;
    return next <= 0.05 ? 0 : next;
  });
}

/** Spots still dirty. */
export function dirtySpots(levels: readonly number[]): number {
  return levels.filter((level) => level > 0).length;
}
