/**
 * The element that scrolls the page vertically around a `WeekGrid` box (owner 2026-10-10: the table
 * scrolls with the page at every width). On `lg`+ the app shell's `main#main-content` is height-bound
 * and scrolls (`overflow-y-auto`); below `lg` it is not bounded, so the *document* scrolls. Rather than
 * hard-coding a breakpoint this walks up from the box and returns the first ancestor that is really a
 * vertical scroll container, else `document.scrollingElement`.
 */
export function pageScroller(box: Element | null): HTMLElement | null {
  for (let node = box?.parentElement ?? null; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/** True when `scroller` is the document's own scroller (its rect is not the viewport: `html`'s top moves with the scroll). */
export function isDocumentScroller(scroller: Element): boolean {
  return scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body;
}

/** The visible vertical extent of `scroller` in viewport coordinates (the whole viewport for the document). */
export function scrollerViewport(scroller: Element): { top: number; bottom: number } {
  if (isDocumentScroller(scroller)) return { top: 0, bottom: window.innerHeight };
  const rect = scroller.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom };
}

/** Height of the fixed bottom nav (phone/tablet) that covers the bottom of the viewport, 0 when absent or hidden. */
export function bottomNavInset(): number {
  const nav = document.querySelector<HTMLElement>("[data-app-bottom-nav]");
  if (!nav || getComputedStyle(nav).display === "none") return 0;
  return nav.getBoundingClientRect().height;
}
