import type { CSSProperties } from "react";

/**
 * Explicit scaling of the week grid (member siddur, Sadran board).
 *
 * The grid used to be scaled with the CSS `zoom` property. WebKit on iPhone resolves `zoom`
 * differently from Chrome (columns shrank but text and ride blocks kept their normal size, so car
 * names broke letter by letter), so the grid is now laid out at 100% and scaled with
 * `transform: scale()`, which every engine treats identically. A transform does not change layout
 * size, hence the outer box that is sized explicitly (`width`, and `height` from the measured inner
 * height) so the scroll area still matches what is drawn.
 *
 * Direction: the app is always RTL (`<html dir="rtl">`), the grid starts at the right edge, so the
 * transform origin is the top-right corner.
 */

/** Below this the zoom is the identity and no transform is applied at all. */
export function isIdentityZoom(zoom: number): boolean {
  return Math.abs(zoom - 1) < 1e-6;
}

/** Layout width (CSS px) of the unscaled grid: at least `minWidth`, else the visible width divided by the zoom. */
export function innerWidthCss(zoom: number, minWidth: number): string {
  return `max(${minWidth}px, calc(100% / ${zoom}))`;
}

/** Visible width of the scroll content: never narrower than the scaled minimum grid width. */
export function outerWidthCss(zoom: number, minWidth: number): string {
  return `max(100%, ${Math.round(minWidth * zoom * 100) / 100}px)`;
}

/** Visible height of a grid whose unscaled layout height is `innerHeight`. */
export function scaledHeight(zoom: number, innerHeight: number): number {
  return Math.ceil(innerHeight * zoom);
}

export function scaledBoxStyles(
  zoom: number,
  minWidth: number,
  innerHeight: number,
): { outer: CSSProperties; inner: CSSProperties } {
  return {
    outer: { position: "relative", width: outerWidthCss(zoom, minWidth), height: scaledHeight(zoom, innerHeight) },
    inner: {
      position: "absolute",
      top: 0,
      insetInlineStart: 0,
      width: innerWidthCss(zoom, minWidth),
      transform: `scale(${zoom})`,
      transformOrigin: "top right",
    },
  };
}

/**
 * The pinned start column (the hours, the header's corner) of a scaled grid. `position: sticky` inside a transformed
 * box goes wrong — Chrome moves it by the zoom factor (the hours "floated" while scrolling sideways), WebKit does not
 * stick at all (owner 2026-11-01) — so that column is drawn outside the scaled box: a sticky strip, itself not
 * transformed, at the scaled width, holding its own copy of the column scaled the same way.
 */
export function pinnedStartStyles(zoom: number, width: number): { strip: CSSProperties; inner: CSSProperties } {
  return {
    strip: { position: "sticky", insetInlineStart: 0, zIndex: 10, width: Math.round(width * zoom * 100) / 100, height: "100%" },
    inner: { width, height: `calc(100% / ${zoom})`, transform: `scale(${zoom})`, transformOrigin: "top right" },
  };
}
