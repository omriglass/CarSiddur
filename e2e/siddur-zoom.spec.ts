import { expect, test, type Page } from "@playwright/test";

import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS } from "./helpers";
import { publishedFixtureWeek } from "./published-week";

/**
 * Owner 2026-11-01: on a zoomed siddur table the hours column floated while scrolling sideways (Chrome moved it by the
 * zoom factor) and on an iPhone it did not stick at all — `position: sticky` inside the grid's `transform: scale()`.
 * Zoomed, the hours and the header's corner are a pinned strip outside the scaled grid; they stay at the right edge.
 */
const WEEK = "2041-04-07";

/** Distance (px) of the hours column's right edge from the grid viewport's right edge (the 1 px border at rest). */
async function hoursOffset(page: Page): Promise<{ hours: number; corner: number }> {
  return page.evaluate(() => {
    const viewport = [...document.querySelectorAll<HTMLElement>("[data-week-grid-scroll-viewport]")].find((el) => el.offsetParent)!;
    const header = document.querySelector<HTMLElement>("[data-week-grid-header]")!;
    const right = viewport.getBoundingClientRect().right;
    const strip = (root: HTMLElement) => (root.querySelector<HTMLElement>("[data-pinned-start]") ?? root.querySelector<HTMLElement>(".sticky"))!;
    return {
      hours: Math.round(right - strip(viewport).getBoundingClientRect().right),
      corner: Math.round(header.getBoundingClientRect().right - strip(header).getBoundingClientRect().right),
    };
  });
}

for (const zoom of [1.5, 2]) {
  test(`the hours column stays at the edge of a scrolled table (zoom ${zoom})`, { tag: ["@siddur"] }, async ({ browser }) => {
    const admin = await publishedFixtureWeek(WEEK);
    await admin.auth.signOut();
    const member = await newSignedInPage(browser, SEEDED_USERS.member1);
    try {
      const page = member.page;
      await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript((tableZoom) => {
        localStorage.setItem("siddur.display.v1", JSON.stringify({ tableView: true, tableZoom, showEarlyHours: false }));
      }, zoom);
      await page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${WEEK}`);
      const viewport = page.locator("[data-week-grid-scroll-viewport]:visible");
      await expect(viewport).toBeVisible();

      await expect(viewport.locator("[data-pinned-start]")).toHaveCount(1);
      const atRest = await hoursOffset(page);
      expect(atRest.hours).toBeLessThanOrEqual(1);

      // RTL: scrolling towards the further cars is a negative scrollLeft; the header follows the body.
      await viewport.evaluate((el) => { el.scrollLeft = -300; el.dispatchEvent(new Event("scroll")); });
      await expect.poll(() => viewport.evaluate((el) => el.scrollLeft)).toBeLessThan(-100);
      await expect.poll(() => hoursOffset(page)).toEqual(atRest);
    } finally {
      await member.context.close().catch(() => undefined);
    }
  });
}
