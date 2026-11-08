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
function buildTileUrl(themeId: string, decoration: ThemeDecoration, inlined: ReadonlyMap<string, string>): string {
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
    const place = `translate(${cx.toFixed(1)} ${cy.toFixed(1)}) rotate(${rotate.toFixed(0)})`;
    if ("image" in motif) {
      const href = inlined.get(motif.image);
      if (href) parts.push(`<image href="${href}" width="${size}" height="${size}" transform="${place} translate(${-size / 2} ${-size / 2})"/>`);
      continue;
    }
    parts.push(`<path d="${motif.d}" fill="${motif.color}" transform="${place} scale(${(size / 24).toFixed(2)}) translate(-12 -12)"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE}" height="${TILE}" viewBox="0 0 ${TILE} ${TILE}">${parts.join("")}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** Image motifs as data URLs (fetched once each): the tile is an SVG background image, which cannot load files. */
function useInlinedImages(decoration: ThemeDecoration | null): ReadonlyMap<string, string> {
  const [inlined, setInlined] = useState<ReadonlyMap<string, string>>(() => new Map());
  const urls = useMemo(
    () => [...new Set((decoration?.motifs ?? []).flatMap((motif) => ("image" in motif ? [motif.image] : [])))],
    [decoration],
  );
  useEffect(() => {
    const missing = urls.filter((url) => !inlined.has(url));
    if (!missing.length) return;
    let cancelled = false;
    void Promise.all(missing.map(async (url) => {
      if (url.startsWith("data:")) return [url, url] as const;
      const blob = await (await fetch(url)).blob();
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      return [url, data] as const;
    })).then((pairs) => {
      if (!cancelled) setInlined((prev) => new Map([...prev, ...pairs]));
    }).catch(() => undefined); // decoration only: without the image the tile still draws its shapes
    return () => { cancelled = true; };
  }, [urls, inlined]);
  return inlined;
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
  const inlined = useInlinedImages(decoration);
  const image = useMemo(() => (decoration ? buildTileUrl(themeId, decoration, inlined) : null), [decoration, themeId, inlined]);
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
