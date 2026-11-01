import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";

import { isIdentityZoom, pinnedStartStyles, scaledBoxStyles } from "./weekGridScale";

interface ScaledGridProps {
  zoom: number;
  gridTemplateColumns: string;
  gridTemplateRows: string;
  /** Unscaled minimum layout width (px). */
  minWidth: number;
  /**
   * The grid's first column (`width` px, its cells at `gridColumn: 1`), drawn outside the scaled box as a sticky strip
   * when zoomed (`pinnedStartStyles`); at zoom 1 the caller puts these cells in `children` as ordinary sticky cells.
   */
  pinnedStart?: { width: number; rows: string; children: ReactNode };
  children: ReactNode;
}

/**
 * The week grid's CSS grid, scaled by `zoom` with `transform: scale()` instead of the CSS `zoom`
 * property (see `weekGridScale.ts`). At zoom 1 it is a plain grid.
 */
export function ScaledGrid({ zoom, gridTemplateColumns, gridTemplateRows, minWidth, pinnedStart, children }: ScaledGridProps) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [innerHeight, setInnerHeight] = useState(0);
  const identity = isIdentityZoom(zoom);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el || identity) return;
    const measure = () => setInnerHeight(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [identity]);

  if (identity) {
    return <div className="grid" style={{ gridTemplateColumns, gridTemplateRows, minWidth }}>{children}</div>;
  }
  const { outer, inner } = scaledBoxStyles(zoom, minWidth, innerHeight);
  const pinned = pinnedStart ? pinnedStartStyles(zoom, pinnedStart.width) : null;
  return (
    <div style={outer}>
      <div ref={innerRef} className="grid" style={{ ...inner, gridTemplateColumns, gridTemplateRows }}>{children}</div>
      {pinnedStart && pinned ? (
        <div style={pinned.strip} data-pinned-start>
          <div className="grid" style={{ ...pinned.inner, gridTemplateColumns: `${pinnedStart.width}px`, gridTemplateRows: pinnedStart.rows }}>{pinnedStart.children}</div>
        </div>
      ) : null}
    </div>
  );
}
