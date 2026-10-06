import { useLayoutEffect, useState } from "react";

/** Tailwind's `lg` breakpoint: the fit applies on a computer only; phones keep their own bound. */
const LG_QUERY = "(min-width: 1024px)";
/** Space left under the box so its border and horizontal scrollbar stay on screen. */
const BOTTOM_GAP_PX = 12;
/** Never shorter than this, even on a short window (the page scrolls instead). */
const MIN_HEIGHT_PX = 448;

/**
 * Owner 2026-10-06 (REQ §13.106): on a computer the siddur/board table must end at the bottom of
 * the screen - no page scrolling to reach its last row or its horizontal scrollbar. Measures where
 * the element starts on the page and returns a `maxHeight` that ends it at the viewport's bottom;
 * `undefined` below `lg`, where the element's own class bound applies. Re-measures on resize and
 * whenever the content above it changes height (banners appearing after data loads).
 */
export function useFitToViewport(): { fitRef: (element: HTMLElement | null) => void; maxHeight: string | undefined } {
  // A callback ref (state), so a box that mounts later - e.g. the table after switching from cards - is measured too.
  const [element, fitRef] = useState<HTMLElement | null>(null);
  const [maxHeight, setMaxHeight] = useState<string | undefined>(undefined);

  useLayoutEffect(() => {
    if (!element || typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia(LG_QUERY);
    const measure = () => {
      if (!media.matches) { setMaxHeight(undefined); return; }
      const top = element.getBoundingClientRect().top + window.scrollY;
      setMaxHeight(`max(${MIN_HEIGHT_PX}px, calc(100dvh - ${Math.round(top) + BOTTOM_GAP_PX}px))`);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(document.body);
    window.addEventListener("resize", measure);
    media.addEventListener?.("change", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      media.removeEventListener?.("change", measure);
    };
  }, [element]);

  return { fitRef, maxHeight };
}
