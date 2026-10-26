import type { CSSProperties } from "react";

import { he } from "@/i18n/he";
import { cn } from "@/lib/utils";

/** One tile of the stamp: the label rotated in a rounded box; the tile repeats over any size. */
function stampTile(label: string, width: number, height: number, fontSize: number): string {
  const boxWidth = Math.round(label.length * fontSize * 0.62 + fontSize);
  const boxHeight = Math.round(fontSize * 1.7);
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}'><g transform='rotate(-30 ${width / 2} ${height / 2})'>`
    + `<rect x='${(width - boxWidth) / 2}' y='${(height - boxHeight) / 2}' width='${boxWidth}' height='${boxHeight}' rx='6' fill='none' stroke='black' stroke-width='2.5'/>`
    + `<text x='${width / 2}' y='${height / 2}' text-anchor='middle' dominant-baseline='central' direction='rtl' font-family='Rubik, Arial, sans-serif' font-weight='900' font-size='${fontSize}'>${label}</text></g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * A "top secret"-style stamp over a day that is not published yet (owner 2026-10-26): "טרם פורסם" repeated
 * diagonally across the whole area the parent covers (the parent must be `relative`). Drawn as a mask over a theme
 * colour, so it follows light/dark mode. Taps pass through to what is underneath; screen readers get the sentence once.
 */
export function DraftWatermark({ className, compact = false }: { className?: string; compact?: boolean }) {
  const label = he.publicationFlow.watermark;
  const tile = compact ? stampTile(label, 110, 150, 13) : stampTile(label, 240, 170, 26);
  const mask: CSSProperties = { maskImage: tile, WebkitMaskImage: tile, maskRepeat: "repeat", WebkitMaskRepeat: "repeat" };
  return (
    <div className={cn("pointer-events-none absolute inset-0 z-[15]", className)} data-testid="draft-watermark">
      <span className="sr-only">{he.publicationFlow.dayUnpublished}</span>
      <div className="absolute inset-0 bg-foreground/[0.16] dark:bg-foreground/[0.2]" style={mask} aria-hidden="true" />
    </div>
  );
}
