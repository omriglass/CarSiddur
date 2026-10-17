import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";

import { isIdentityZoom, scaledBoxStyles } from "./weekGridScale";

interface ScaledGridProps {
  zoom: number;
  gridTemplateColumns: string;
  gridTemplateRows: string;
  /** Unscaled minimum layout width (px). */
  minWidth: number;
  children: ReactNode;
}

/**
 * The week grid's CSS grid, scaled by `zoom` with `transform: scale()` instead of the CSS `zoom`
 * property (see `weekGridScale.ts`). At zoom 1 it is a plain grid.
 */
export function ScaledGrid({ zoom, gridTemplateColumns, gridTemplateRows, minWidth, children }: ScaledGridProps) {
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
  return (
    <div style={outer}>
      <div ref={innerRef} className="grid" style={{ ...inner, gridTemplateColumns, gridTemplateRows }}>{children}</div>
    </div>
  );
}
