/**
 * Colour maths for themes (REQ §13.196): hex ↔ HSL, WCAG relative luminance / contrast ratio, mixing and the
 * lightness search that moves a colour until it reads against a surface. Pure — no DOM.
 */

export interface Hsl {
  h: number; // 0..360
  s: number; // 0..100
  l: number; // 0..100
}

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHex(value: string): boolean {
  return HEX_RE.test(value.trim());
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = HEX_RE.exec(hex.trim());
  if (!m?.[1]) throw new Error(`not a hex colour: ${hex}`);
  let body = m[1];
  if (body.length === 3) body = body.split("").map((c) => c + c).join("");
  const n = parseInt(body, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHsl([r8, g8, b8]: [number, number, number]): Hsl {
  const r = r8 / 255, g = g8 / 255, b = b8 / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }: Hsl): [number, number, number] {
  const sn = s / 100, ln = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export function hexToHsl(hex: string): Hsl {
  return rgbToHsl(hexToRgb(hex));
}

export function hslToHex(hsl: Hsl): string {
  return "#" + hslToRgb(hsl).map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** `"217 91% 34%"` — the token format `index.css` uses, so `hsl(var(--x) / <alpha>)` keeps working. */
export function toHslVar({ h, s, l }: Hsl): string {
  const r = (n: number) => Math.round(n * 10) / 10;
  return `${r(h)} ${r(s)}% ${r(l)}%`;
}

/** Parses `"217 91% 34%"` back (the neutral tokens are written that way). */
export function parseHslVar(value: string | undefined): Hsl {
  const m = /^\s*(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*$/.exec(value ?? "");
  if (!m) throw new Error(`not an HSL token: ${value}`);
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) };
}

export function luminance(hsl: Hsl): number {
  const [r = 0, g = 0, b = 0] = hslToRgb(hsl).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: Hsl, b: Hsl): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function isDark(hsl: Hsl): boolean {
  return luminance(hsl) < 0.18;
}

/** Linear mix in HSL space (hue along the short arc); `t = 0` → `a`, `t = 1` → `b`. */
export function mix(a: Hsl, b: Hsl, t: number): Hsl {
  let dh = b.h - a.h;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  // A grey has no meaningful hue: take the other colour's.
  const h = a.s < 1 ? b.h : b.s < 1 ? a.h : (a.h + dh * t + 360) % 360;
  return { h, s: a.s + (b.s - a.s) * t, l: a.l + (b.l - a.l) * t };
}

export function withLightness(c: Hsl, l: number): Hsl {
  return { ...c, l: Math.max(0, Math.min(100, l)) };
}

/**
 * Moves `color`'s lightness, in 1-point steps, until it reaches `ratio` against every surface in `against`.
 * Tries the direction away from the surfaces first (darker on light surfaces), then the other; falls back to
 * black or white, whichever reads better. Returns the colour unchanged when it already passes.
 */
export function ensureContrast(color: Hsl, against: readonly Hsl[], ratio: number): Hsl {
  const passes = (c: Hsl) => against.every((s) => contrast(c, s) >= ratio);
  if (passes(color)) return color;
  const surfacesDark = against.every(isDark);
  const first = surfacesDark ? 1 : -1;
  for (const dir of [first, -first]) {
    for (let l = color.l + dir; l >= 0 && l <= 100; l += dir) {
      const candidate = withLightness(color, l);
      if (passes(candidate)) return candidate;
    }
  }
  const black: Hsl = { h: 0, s: 0, l: 0 }, white: Hsl = { h: 0, s: 0, l: 100 };
  const minRatio = (c: Hsl) => Math.min(...against.map((s) => contrast(c, s)));
  return minRatio(black) >= minRatio(white) ? black : white;
}
