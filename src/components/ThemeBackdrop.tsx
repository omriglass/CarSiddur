import { useEffect, useMemo, useState } from "react";

import { currentAppearance, THEME_CHANGE_EVENT } from "@/themes/apply";
import type { ThemeDecoration } from "@/themes/types";

const TILE = 240;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Small deterministic PRNG (mulberry32) seeded from the theme id: the same theme always draws the same tile. */
function seededRandom(seed: string): () => number {
  let h = 1779033703;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
  let a = (h ^ (h >>> 16)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Builds the 240×240 SVG tile as a data URL. Motifs are placed on a jittered grid so none clump, and wrap at the edges. */
function buildTileUrl(themeId: string, decoration: ThemeDecoration): string {
  const rand = seededRandom(themeId);
  const count = Math.round(clamp(decoration.perTile, 1, 14));
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cells = Array.from({ length: cols * rows }, (_, i) => i);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cells[i], cells[j]] = [cells[j] ?? j, cells[i] ?? i];
  }
  const parts: string[] = [];
  for (let n = 0; n < count; n++) {
    const motif = decoration.motifs[n % decoration.motifs.length];
    const cell = cells[n];
    if (!motif || cell === undefined) continue;
    const size = motif.size ?? 28;
    const cx = ((cell % cols) + 0.2 + rand() * 0.6) * (TILE / cols);
    const cy = (Math.floor(cell / cols) + 0.2 + rand() * 0.6) * (TILE / rows);
    const rotate = (motif.rotate ?? 0) + (rand() - 0.5) * 30;
    const scale = size / 24;
    parts.push(
      `<path d="${motif.d}" fill="${motif.color}" transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)}) rotate(${rotate.toFixed(0)}) scale(${scale.toFixed(2)}) translate(-12 -12)"/>`,
    );
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE}" height="${TILE}" viewBox="0 0 ${TILE} ${TILE}">${parts.join("")}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * Faint theme decoration (REQ §13.196 d): one fixed layer behind all content, never interactive. Cards and the
 * schedule grids paint their own backgrounds over it. Drift stops under reduced motion (`index.css`).
 */
export function ThemeBackdrop() {
  const [appearance, setAppearance] = useState(currentAppearance);
  useEffect(() => {
    const sync = () => setAppearance(currentAppearance());
    sync();
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync);
  }, []);

  const decoration = appearance?.decoration ?? null;
  const themeId = appearance?.themeId ?? "";
  const image = useMemo(() => (decoration ? buildTileUrl(themeId, decoration) : null), [decoration, themeId]);
  if (!decoration || !image) return null;

  return (
    <div
      aria-hidden="true"
      data-testid="theme-backdrop"
      className={`pointer-events-none fixed inset-0 -z-10 ${decoration.drift ? "theme-backdrop-drift" : ""}`}
      style={{
        backgroundImage: image,
        backgroundSize: `${TILE}px ${TILE}px`,
        opacity: clamp(decoration.opacity, 0.04, 0.2),
      }}
    />
  );
}
