import { useSyncExternalStore } from "react";

/**
 * UX_FLOWS §9 "The on-screen keyboard never hides the open picker" (REQ §13.185 d).
 *
 * Android Chrome shrinks the page above the keyboard (`interactive-widget=resizes-content` in index.html).
 * iOS Safari does not: the keyboard covers the bottom of the layout viewport and only `visualViewport`
 * shrinks. `installKeyboardInset()` publishes, on `<html>`:
 *   - `--kb-inset`   — px of the layout viewport hidden below the visible area (the keyboard; 0 on Android),
 *   - `--vv-height`  — px of the visible area,
 *   - `--vv-top`     — px the visible area is scrolled down from the layout viewport's top.
 * Bottom sheets sit at `bottom: var(--kb-inset)` and fit in `--vv-height` (`PortalSheetContent`), dialogs
 * centre in the visible area (`PortalDialogContent`), popovers avoid it (`useKeyboardInset()` as
 * `collisionPadding`), and a focused field is scrolled into the visible area once the keyboard is up.
 */

let inset = 0;
const listeners = new Set<() => void>();

function measure() {
  const vv = window.visualViewport;
  if (!vv) return;
  const next = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
  const root = document.documentElement.style;
  root.setProperty("--kb-inset", `${next}px`);
  root.setProperty("--vv-height", `${Math.round(vv.height)}px`);
  root.setProperty("--vv-top", `${Math.round(vv.offsetTop)}px`);
  if (next !== inset) {
    inset = next;
    listeners.forEach((l) => l());
  }
}

function isTextField(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && !["checkbox", "radio", "button", "submit", "range", "file"].includes((el as HTMLInputElement).type);
}

export function installKeyboardInset() {
  const vv = window.visualViewport;
  if (!vv) return;
  vv.addEventListener("resize", measure);
  vv.addEventListener("scroll", measure);
  window.addEventListener("resize", measure);
  measure();
  // Once the keyboard has finished sliding up, bring the focused field (and the list under it) into view.
  document.addEventListener("focusin", (event) => {
    const target = event.target as Element | null;
    if (!isTextField(target)) return;
    window.setTimeout(() => {
      if (document.activeElement === target) target.scrollIntoView({ block: "nearest" });
    }, 350);
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current keyboard height in px (0 when hidden, and always 0 on Android, where the page itself shrinks). */
export function useKeyboardInset(): number {
  return useSyncExternalStore(subscribe, () => inset, () => 0);
}
