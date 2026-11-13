// Urea fill game (FU2, REQ item 219): pure geometry and timing, so the component only renders and the rules are
// unit-tested. Drawing units are the SVG's viewBox (UREA_W × UREA_H).

export const UREA_W = 320;
export const UREA_H = 200;

/** Where the stream leaves the boy (his front hip, facing the car). */
export const STREAM_SOURCE = { x: 76, y: 132 } as const;

/** The funnel's open rim, the stream must land between `left` and `right` at height `y`. */
export const FUNNEL = { left: 214, right: 250, y: 74 } as const;

/** Where the stream starts landing: short of the car, on the ground — off the funnel. */
export const START_AIM = 150;
export const MIN_AIM = 96;
export const MAX_AIM = 312;

/** Seconds of stream inside the funnel to fill the tank. */
export const FILL_SECONDS = 2.6;

/** While nobody holds the stream it sags back towards the boy (px per second). */
export const SAG_PER_SECOND = 9;

export function clampAim(aim: number): number {
  return Math.min(MAX_AIM, Math.max(MIN_AIM, aim));
}

/** A small, slightly irregular wobble (px) so the stream needs a steady hand; none with reduced motion. */
export function wobble(seconds: number, motion = true): number {
  if (!motion) return 0;
  return 7 * Math.sin(seconds * 2.3) + 4 * Math.sin(seconds * 3.9 + 1.1);
}

export function hitsFunnel(landingX: number): boolean {
  return landingX >= FUNNEL.left + 3 && landingX <= FUNNEL.right - 3;
}

/**
 * The height the stream lands at: the funnel rim when it reaches the car's side of the funnel, else the ground.
 * Short of the funnel it falls to the ground in front of the car.
 */
export function landingY(landingX: number): number {
  return hitsFunnel(landingX) ? FUNNEL.y : GROUND_Y;
}

export const GROUND_Y = 182;

/** The stream as a quadratic arc from the boy to where it lands; higher arc the further it goes. */
export function streamPath(landingX: number): string {
  const { x: sx, y: sy } = STREAM_SOURCE;
  const ly = landingY(landingX);
  const reach = landingX - sx;
  const cx = sx + reach * 0.45;
  const cy = Math.min(sy, ly) - 30 - reach * 0.32;
  return `M${sx} ${sy} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${landingX.toFixed(1)} ${ly}`;
}

/** One animation step: the new fill (0..1) after `dt` seconds with the stream landing at `landingX`. */
export function nextFill(fill: number, landingX: number, dt: number): number {
  if (!hitsFunnel(landingX)) return fill;
  return Math.min(1, fill + dt / FILL_SECONDS);
}

/** The drawing x of a pointer, from its screen position through the SVG's own transform. */
export function aimFromPointer(drawingX: number): number {
  return clampAim(drawingX);
}
