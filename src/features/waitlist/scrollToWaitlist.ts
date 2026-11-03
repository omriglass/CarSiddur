/** REQ §13.182: what the waiting-list button scrolls to, in page order — the "בדיון" lane/cards first, then the waiting columns/cards. */
const WAITLIST_ANCHORS = '[data-discussion-lane], [data-car-col-id^="phantom:waiting:"], [data-testid="waitlist-group-summary"], [data-testid="siddur-waiting-card"]';

/**
 * Smoothly brings the first visible waiting-list element into view. In the table it scrolls the grid sideways
 * (the grid's own scroller; the pinned car-header strip follows it) and the page only as far as the grid needs —
 * never to the column's top row; in the list view it centres the card.
 */
export function scrollToWaitlist(): void {
  const target = Array.from(document.querySelectorAll<HTMLElement>(WAITLIST_ANCHORS)).find((el) => el.getClientRects().length > 0);
  if (!target) return;
  const viewport = target.closest<HTMLElement>("[data-week-grid-scroll-viewport]");
  if (!viewport) {
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const lane = target.getBoundingClientRect();
  const box = viewport.getBoundingClientRect();
  viewport.scrollBy({ left: lane.left - box.left - (box.width - lane.width) / 2, behavior: "smooth" });
  if (box.top < 0 || box.top > window.innerHeight * 0.5) viewport.scrollIntoView({ behavior: "smooth", block: "start" });
}
